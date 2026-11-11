// =============================================================================
// Memory Digest Enrichment Handler (epic #300, issue #311)
// =============================================================================
//
// Runs one circle's digest send. Enqueued once per due circle by
// MemoryDigestTask.
//
// A native platform `JobHandler` (RETRO-C8, #608): the circle is the job's
// subject (`subjectType: 'circle'`); a job about anything else throws, a circle
// deleted since the job was queued settles as a no-op.
//
// SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` pair, so
// the platform's JobHandlerRegistry.serverOnlyTypes() picks the type up and it
// stays in the system worker mode's claim set with no explicit pinning — the
// same inference that covers `memory_generation`,
// `face_auto_archive_sweep` and the `location_inference` sweep. There is no
// per-item unit of work to hand a node, and the send needs a server-held email
// credential plus the `SECRETS_ENCRYPTION_KEY`-derived signing key that a node
// never holds. It is correspondingly ABSENT from the CLI's NODE_JOB_TYPES.
//
// WHY IT IS A JOB AT ALL, rather than in-process work like ShareExpiringTask's
// sweep: sending is the one part of this feature that talks to a third party,
// so it is the part that genuinely fails transiently. Being a job row gives it
// the queue's retry budget, makes a stuck send visible in /admin/settings/jobs,
// and bounds a broken provider to ENRICHMENT_MAX_ATTEMPTS instead of an hourly
// silent failure nobody sees. (#246's reconcile is in-process for the opposite
// reason: it is pure local SQL that cannot fail transiently.)
//
// RETRY SEMANTICS. `process` throws only when the send pass itself blew up
// (an infrastructure error). Every per-recipient failure is counted inside
// MemoryDigestService and the job SUCCEEDS, because a retry would re-mail
// everybody the first pass already reached — there is no per-recipient
// checkpoint, and duplicate mail is worse than a missed one. A closed gate is
// likewise a SUCCESS, not a failure: a disabled feature is not an error, and
// failing would burn retry attempts and light up the dashboard for no reason
// (same posture as MemoryGenerationHandler).
//
// THE WATERMARK IS THE JOB ROW ITSELF. Nothing is written to record "the digest
// was sent" — `finishedAt` of this succeeded row in the platform `jobs` table IS
// the watermark the next period reads (see MemoryDigestService.lastDigestAt). That is what makes a
// hand-retry from the admin dashboard safe to reason about, and it is why the
// handler must not fail on a partial send: a failed row is not a watermark, so
// the next tick would re-send everything.
// =============================================================================

import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';

import { resolveCircleJob } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  type MemoriahubAccessPort,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
} from '../../ports/index.js';
import { MEMORY_DIGEST_JOB_TYPE, MemoryDigestService } from './memory-digest.service.js';

/**
 * The `memory_digest` job handler: one circle's render-and-send, server-only.
 *
 * @stability experimental
 */
@Injectable()
export class MemoryDigestHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = MEMORY_DIGEST_JOB_TYPE;

  readonly label = 'Memory email digest';

  /**
   * One circle's render-and-send: 15 minutes, and only TWO attempts. A retry
   * re-mails nobody it already reached only because a partial send succeeds;
   * a failed attempt is an infrastructure error worth one more try, not three.
   */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 900_000, maxAttempts: 2 };

  private readonly logger = new Logger(MemoryDigestHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
    private readonly digest: MemoryDigestService,
    // App metrics (RETRO-T3, #628): `app.memories.digest.sent`. Optional for hand-built tests.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Sends one circle's digest.
   *
   * @param job - the queue's job; its subject is the circle.
   */
  async process(job: MemoriahubJob): Promise<void> {
    // A digest is per circle by construction: the circle is the job's subject.
    const circleId = await resolveCircleJob(this.scopes, job, this.logger);
    if (!circleId) return;

    const result = await this.digest.sendForCircle(circleId);

    // Quiet when the run was a deliberate no-op (gate closed, or no new content
    // since the watermark) — that is the expected steady state for most circles
    // most of the time and an hourly log line saying so is noise.
    if (result.skippedReason) {
      this.logger.debug(
        `memory_digest job ${job.id} (circle ${circleId}) skipped: ${result.skippedReason}`,
      );
      return;
    }

    this.metrics?.add('memoriesDigestSent', result.sent, { outcome: 'sent' });
    this.metrics?.add('memoriesDigestSent', result.skippedOptOut + result.skippedEmpty + result.skippedNoEmail, {
      outcome: 'skipped',
    });
    this.metrics?.add('memoriesDigestSent', result.failed, { outcome: 'failed' });
    this.logger.log({
      event: 'memory_digest.completed',
      jobId: job.id,
      circleId,
      candidates: result.candidates,
      recipients: result.recipients,
      sent: result.sent,
      skippedOptOut: result.skippedOptOut,
      skippedEmpty: result.skippedEmpty,
      skippedNoEmail: result.skippedNoEmail,
      failed: result.failed,
    });
  }
}
