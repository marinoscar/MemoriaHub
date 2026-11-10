import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  JOB_SETTLED_EVENT,
  JobHandlerRegistry,
  JobScope,
  JobsService,
  ProviderThrottleService,
  RateLimitError,
  buildDedupKey,
  enqueueHousekeepingJob,
  jobTempPath,
  type Job,
  type JobHandler,
  type JobSettledEvent,
  type JobsInputJsonObject,
  type JobsTx,
} from '@marinoscar/platform-api/jobs';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  MemoriahubRateLimitError,
  type MemoriahubActiveJob,
  type MemoriahubActiveJobQuery,
  type MemoriahubEnqueueInput,
  type MemoriahubEnqueueResult,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobSettledEvent,
  type MemoriahubJobsPort,
} from '@marinoscar/memoriahub-api/ports';

import { DefaultOrgId } from '../../common/tenancy/default-org-id';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// PlatformMemoriahubJobsAdapter: the `MEMORIAHUB_JOBS` port over the platform queue (RETRO-J4, #610)
// =============================================================================
//
// `registerHandler` adapts a `MemoriahubJobHandler` to the platform `JobHandler` with the SAME
// `type`, `profile`, `nodeResultSchema`, `persistNodeResult`, `nodeSecretBroker`, `deriveOutputKey`,
// `nodeOffloadEnabled` and `canDelete`, and registers it with `JobHandlerRegistry`: the queue, the
// lease, the worker nodes and the admin list see an ordinary handler. A `type` string is permanent once
// jobs of it exist, so the adapter never rewrites one (`test/jobs/job-type-snapshot.spec.ts` pins them).
//
// WHAT THE ADAPTER DOES THAT A HANDLER MUST NOT HAVE TO:
//   * `MemoriahubRateLimitError` -> the platform's `RateLimitError`, because the queue defers a job on
//     `instanceof RateLimitError` and nothing else. The throttle key the error names is registered first,
//     so the cooldown lands on that bucket.
//   * the organization: a job with a subject belongs to the default organization (single-organization
//     mode); a subject-less job (a housekeeping sweep) belongs to none (`orgId: null`). An explicit
//     `orgId` on the input wins.
//   * dedup is reported: the platform returns the row either way, so the adapter looks the active one up.
//
// AI JOBS ARE SERVER-ONLY, PERMANENTLY: a handler that declares `usesAi` and the node pair is refused at
// registration (boot), as is one half of the pair (eligibility is derived from both members).
// =============================================================================

/** The enqueue reason when a caller gives none: new work, as an upload is. */
const DEFAULT_REASON = 'upload';

@Injectable()
export class PlatformMemoriahubJobsAdapter implements MemoriahubJobsPort {
  private readonly logger = new Logger(PlatformMemoriahubJobsAdapter.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly scope: JobScope,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly defaultOrg: DefaultOrgId,
  ) {}

  @Trace()
  async enqueue(input: MemoriahubEnqueueInput): Promise<MemoriahubEnqueueResult> {
    const orgId = await this.orgIdOf(input);

    // The platform returns the row either way and does not say which; look first. A concurrent
    // identical enqueue between this read and the insert is reported as new, which is harmless: the
    // postcondition ("one job for this work is queued") holds.
    const existing =
      input.skipDedup === true
        ? null
        : ((await this.prisma.job.findFirst({
            where: {
              dedupKey: buildDedupKey(input.type, input.subjectType, input.subjectId),
              status: { in: ['pending', 'running'] },
            },
            select: { id: true },
          })) ?? null);

    const job = await this.jobs.enqueue(this.toPlatform(input, orgId));

    if (input.throttleKey !== undefined && existing === null) {
      await this.jobs.recordProvider(job.id, input.throttleKey, null);
    }

    return { id: job.id, deduplicated: existing !== null && existing.id === job.id };
  }

  /** Joins the caller's open transaction through the platform queue's `enqueueWithin`. */
  @Trace()
  async enqueueWithin(tx: unknown, input: MemoriahubEnqueueInput): Promise<MemoriahubEnqueueResult> {
    const orgId = await this.orgIdOf(input);
    const job = await this.jobs.enqueueWithin(tx as JobsTx, this.toPlatform(input, orgId));

    // `throttleKey` is not recorded here: the job row exists only once the caller's transaction commits,
    // and a handler that hits a provider limit names its bucket itself (`MemoriahubRateLimitError`).
    return { id: job.id, deduplicated: false };
  }

  @Trace()
  async enqueueHousekeeping(input: { type: string; what: string }): Promise<{ id: string } | null> {
    const job = await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: input.type,
      what: input.what,
    });
    return job ? { id: job.id } : null;
  }

  registerHandler(handler: MemoriahubJobHandler): void {
    if (handler.nodeResultSchema !== undefined && handler.usesAi === true) {
      throw new Error(
        `Job type "${handler.type}" calls a model and may not declare nodeResultSchema: AI jobs are server-only because a key is never brokered to a worker node.`,
      );
    }
    if ((handler.nodeResultSchema === undefined) !== (handler.persistNodeResult === undefined)) {
      throw new Error(
        `Job type "${handler.type}" must declare nodeResultSchema and persistNodeResult together or neither.`,
      );
    }

    const adapted: JobHandler = {
      type: handler.type,
      ...(handler.label !== undefined ? { label: handler.label } : {}),
      ...(handler.profile !== undefined ? { profile: handler.profile } : {}),
      process: (job) => this.run(handler, job),
      ...(handler.nodeResultSchema !== undefined && handler.persistNodeResult !== undefined
        ? {
            nodeResultSchema: handler.nodeResultSchema,
            persistNodeResult: (job: Job, result: unknown) => handler.persistNodeResult!(toDomainJob(job), result),
          }
        : {}),
      ...(handler.nodeSecretBroker !== undefined
        ? {
            nodeSecretBroker: {
              kind: handler.nodeSecretBroker.kind,
              usable: () => handler.nodeSecretBroker!.usable(),
              issue: (job: Job, until: Date) => handler.nodeSecretBroker!.issue(toDomainJob(job), until),
              revoke: (handle: string) => handler.nodeSecretBroker!.revoke(handle),
            },
          }
        : {}),
      ...(handler.deriveOutputKey !== undefined
        ? { deriveOutputKey: (job: Job) => handler.deriveOutputKey!(toDomainJob(job)) }
        : {}),
      ...(handler.nodeOffloadEnabled !== undefined ? { nodeOffloadEnabled: () => handler.nodeOffloadEnabled!() } : {}),
      ...(handler.canDelete !== undefined ? { canDelete: (job: Job) => handler.canDelete!(toDomainJob(job)) } : {}),
    };

    this.registry.register(adapted);

    // A handler whose type draws on ONE deployment-wide provider bucket says so here.
    if (handler.throttleKey !== undefined) this.throttle.registerProviderKey(handler.type, handler.throttleKey);
  }

  isRegistered(type: string): boolean {
    return this.registry.get(type) !== undefined;
  }

  onSettled(listener: (event: MemoriahubJobSettledEvent) => void): void {
    this.events.on(JOB_SETTLED_EVENT, (event: JobSettledEvent) => {
      if (event.status !== 'succeeded' && event.status !== 'failed') return;

      try {
        listener({
          jobId: event.jobId,
          type: event.type,
          status: event.status,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          payload: event.job.payload,
          lastError: event.lastError,
        });
      } catch (error) {
        this.logger.error(
          `A job-settled listener threw for ${event.jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  @Trace()
  async findActive(query: MemoriahubActiveJobQuery): Promise<MemoriahubActiveJob[]> {
    const matches: Array<Record<string, unknown>> = [];

    if (query.subjectIds !== undefined && query.subjectIds.length > 0) {
      matches.push({
        ...(query.subjectType !== undefined ? { subjectType: query.subjectType } : {}),
        subjectId: { in: [...query.subjectIds] },
      });
    }

    if (query.payloadKey !== undefined) {
      for (const value of query.payloadValues ?? []) {
        matches.push({ payload: { path: [query.payloadKey], equals: value } });
      }
    }

    if (matches.length === 0 && (query.subjectIds !== undefined || query.payloadValues !== undefined)) return [];

    const rows = await this.prisma.job.findMany({
      where: {
        type: { in: [...query.types] },
        status: { in: ['pending', 'running'] },
        ...(query.excludeJobId !== undefined ? { id: { not: query.excludeJobId } } : {}),
        ...(matches.length > 0 ? { OR: matches } : {}),
      },
      select: { id: true, type: true, subjectType: true, subjectId: true, payload: true },
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      payload: row.payload,
    }));
  }

  runInJobScope<R>(job: Pick<MemoriahubJob, 'id' | 'orgId'>, fn: (tx: any) => Promise<R>): Promise<R> {
    return this.scope.run(job, fn);
  }

  tempPath(suffix?: string): string {
    return jobTempPath(suffix);
  }

  @Trace()
  async recordProvider(jobId: string, provider: string | null, model: string | null): Promise<void> {
    await this.jobs.recordProvider(jobId, provider, model);
  }

  /** One attempt: register the job's throttle bucket, run, and translate a rate limit. */
  private async run(handler: MemoriahubJobHandler, job: Job): Promise<void> {
    if (job.providerKey) this.throttle.registerProviderKey(job.type, job.providerKey);

    try {
      await handler.process(toDomainJob(job));
    } catch (error) {
      if (error instanceof MemoriahubRateLimitError) {
        this.throttle.registerProviderKey(job.type, error.throttleKey);
        throw new RateLimitError(error.message, error.retryAfterMs);
      }
      throw error;
    }
  }

  private async orgIdOf(input: MemoriahubEnqueueInput): Promise<string | null> {
    if (input.orgId !== undefined) return input.orgId;
    return input.subjectType ? this.defaultOrg.get() : null;
  }

  private toPlatform(input: MemoriahubEnqueueInput, orgId: string | null) {
    return {
      type: input.type,
      reason: input.reason ?? DEFAULT_REASON,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      payload: input.payload as JobsInputJsonObject,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      scheduledFor: input.scheduledFor ?? null,
      skipDedup: input.skipDedup === true,
      orgId,
    };
  }
}

/** The handler's view of a platform job row. */
function toDomainJob(job: Job): MemoriahubJob {
  return {
    id: job.id,
    type: job.type,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    payload: job.payload,
    attempts: job.attempts,
    orgId: job.orgId,
    status: job.status,
  };
}
