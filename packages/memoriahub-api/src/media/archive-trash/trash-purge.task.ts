// =============================================================================
// Trash Purge Scheduled Task (enqueue-only)
// =============================================================================
//
// Hourly cron that enqueues the global `trash_purge` job (`TrashPurgeHandler`)
// when none is already pending or running. `enqueueHousekeeping` does that
// check, queues a system job (`orgId: null`) at the housekeeping priority (100)
// and never throws. The cron decides nothing else and works inline on nothing.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';

/**
 * Enqueues the hourly trash purge.
 *
 * @stability experimental
 */
@Injectable()
export class TrashPurgeTask {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  /** The hourly tick. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledPurge(): Promise<void> {
    await this.enqueueHousekeepingJob();
  }

  /**
   * Asks the jobs port for the global housekeeping job: the host checks that no `trash_purge` is
   * already pending or running, queues a system job at the housekeeping priority and never throws.
   */
  private async enqueueHousekeepingJob(): Promise<void> {
    await this.jobs.enqueueHousekeeping({ type: 'trash_purge', what: 'trash purge' });
  }
}
