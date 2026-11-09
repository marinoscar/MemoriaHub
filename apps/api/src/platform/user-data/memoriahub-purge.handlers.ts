import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';
import { z } from 'zod';

import { MemoriaHubUserDataService, type Counts } from './memoriahub-user-data.service';

// =============================================================================
// MemoriaHub's delegated user-data purges (RETRO-H1, #591)
// =============================================================================
//
// `user.data.purge` (the platform's Danger Zone job) deletes the user's inline
// rows itself and, for every model hinted with a `delegate`, enqueues the job
// named here AFTER its own rows commit (subject `user:<userId>`, `orgId: null`,
// payload `{ userId }`). Each job is one category of MemoriaHub data; circle
// content is scoped to the user's PERSONAL circle: what the user added to a
// circle other people share stays there (see `user-data.manifest.ts`).
//
// The three type strings are PERMANENT once a row carried them. Server-only,
// permanently: no `nodeResultSchema` / `persistNodeResult` (a purge needs
// storage credentials and deletes rows; no worker node is trusted with that).
// Every handler is idempotent: deletes are by predicate and pages re-select
// what is left, so the queue's retry finishes the work.
//
// `orgId`: the platform enqueues the delegates with `orgId: null`. MemoriaHub's
// circle tables carry no `org_id` (single-organization mode until Epic I), so
// nothing here needs a `JobScope`; the storage-object deletes run on the
// system client (`PrismaSystemService.asSystem('purge')`).
// =============================================================================

/** The delegated job types (permanent). */
export const MEMORIAHUB_PURGE_JOB_TYPES = {
  CIRCLE: 'memoriahub.circle.purge',
  DEVICES: 'memoriahub.media_sync.purge',
  PROFILE: 'memoriahub.profile.purge',
} as const;

const payloadSchema = z.object({ userId: z.string().uuid() });

/** Reads `{ userId }` from a delegated job's payload. */
export function purgeUserIdOf(job: Pick<Job, 'id' | 'type' | 'payload'>): string {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`${job.type} job ${job.id}: payload must carry { userId (uuid) }`);
  return parsed.data.userId;
}

abstract class MemoriaHubPurgeHandler implements JobHandler, OnModuleInit {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 3 };
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly registry: JobHandlerRegistry,
    protected readonly data: MemoriaHubUserDataService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  protected abstract purge(userId: string): Promise<Counts>;

  async process(job: Job): Promise<void> {
    const userId = purgeUserIdOf(job);
    const counts = await this.purge(userId);
    // Counts only, never content (the issue's observability rule).
    this.logger.log(`${this.type} job ${job.id}: ${JSON.stringify(counts)}`);
  }
}

/**
 * The personal circle emptied: photos and videos with every stored file, albums,
 * tags, people and faces, memories and workflows. The circle itself stays.
 */
@Injectable()
export class CirclePurgeHandler extends MemoriaHubPurgeHandler {
  readonly type = MEMORIAHUB_PURGE_JOB_TYPES.CIRCLE;
  readonly label = 'Delete personal library';
  /** A whole library: paged, so a retry continues where the attempt stopped. */
  override readonly profile: JobExecutionProfile = { maxRuntimeMs: 60 * 60_000, maxAttempts: 3 };

  constructor(registry: JobHandlerRegistry, data: MemoriaHubUserDataService) {
    super(registry, data);
  }

  protected async purge(userId: string): Promise<Counts> {
    const counts = await this.data.purgePersonalCircle(userId);
    if ((counts.mediaItemsFailed ?? 0) > 0) {
      // Fail the attempt so the queue retries the rows that stayed.
      throw new Error(`${counts.mediaItemsFailed} media item(s) could not be deleted; retrying`);
    }
    return counts;
  }
}

/** The user's paired phones and their tokens. */
@Injectable()
export class DevicesPurgeHandler extends MemoriaHubPurgeHandler {
  readonly type = MEMORIAHUB_PURGE_JOB_TYPES.DEVICES;
  readonly label = 'Unpair media sync devices';

  constructor(registry: JobHandlerRegistry, data: MemoriaHubUserDataService) {
    super(registry, data);
  }

  protected purge(userId: string): Promise<Counts> {
    return this.data.purgeDevices(userId);
  }
}

/** The profile picture and the person link. */
@Injectable()
export class ProfilePurgeHandler extends MemoriaHubPurgeHandler {
  readonly type = MEMORIAHUB_PURGE_JOB_TYPES.PROFILE;
  readonly label = 'Delete profile picture';

  constructor(registry: JobHandlerRegistry, data: MemoriaHubUserDataService) {
    super(registry, data);
  }

  protected purge(userId: string): Promise<Counts> {
    return this.data.purgeProfile(userId);
  }
}

export const MEMORIAHUB_PURGE_HANDLERS = [
  CirclePurgeHandler,
  DevicesPurgeHandler,
  ProfilePurgeHandler,
] as const;
