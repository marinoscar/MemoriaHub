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
