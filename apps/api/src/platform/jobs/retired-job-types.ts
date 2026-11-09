import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Retired job types (RETRO-C1, #575)
// =============================================================================
//
// A job `type` string is permanent once rows of it exist. `job_history_purge`
// was the old queue's nightly purge; the platform's `job.history.purge` replaces
// it. Rows of the old type may be `pending` at the cutover (migrated as they
// were) or sit in history. This handler lets a pending one settle: it succeeds
// without doing anything, because the platform purge already runs on its own
// schedule. Nothing enqueues the type any more.
//
// Server-only (no node pair). It goes when the history of the type is purged.
// =============================================================================

export const RETIRED_JOB_HISTORY_PURGE_TYPE = 'job_history_purge';

@Injectable()
export class RetiredJobTypeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(RetiredJobTypeHandler.name);

  readonly type = RETIRED_JOB_HISTORY_PURGE_TYPE;

  constructor(private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    this.logger.log(
      `Job ${job.id} of the retired type "${this.type}" settles without work: ` +
        'the platform job.history.purge runs the purge now',
    );
  }
}

// =============================================================================
// `storage_migration` (RETRO-D1, #563)
// =============================================================================
//
// MemoriaHub's own copy-only provider migration enqueued one `storage_migration`
// job per object and recorded progress in `storage_migration_runs/items` (renamed
// `mh_legacy_storage_migration_*` by RETRO-A5b). Since RETRO-D1 the platform's
// migration (`/api/admin/storage/migrations`, jobs `storage.migrate_plan` and
// `storage.migrate_object`) replaces it; nothing enqueues the old type.
//
// A row still pending at the cutover settles here WITHOUT copying: the legacy
// tables are frozen history and are never written again. An operator re-runs the
// migration from /admin/settings/storage; the platform's planner skips every
// object already on the target, so nothing is copied twice.
// =============================================================================

export const RETIRED_STORAGE_MIGRATION_TYPE = 'storage_migration';

@Injectable()
export class RetiredStorageMigrationHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(RetiredStorageMigrationHandler.name);

  readonly type = RETIRED_STORAGE_MIGRATION_TYPE;
  readonly label = 'Storage migration (retired)';

  constructor(private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    this.logger.warn(
      `Job ${job.id} of the retired type "${this.type}" settles without copying: the provider migration is ` +
        "the platform's since RETRO-D1. Re-run it from /admin/settings/storage; objects already on the target are skipped.",
    );
  }
}
