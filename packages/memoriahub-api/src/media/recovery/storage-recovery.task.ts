// =============================================================================
// StorageRecoveryTask: the 10-minute stuck-object recovery cron (RETRO-D1b #567, RETRO-J5 #613)
// =============================================================================
//
// Decides only that recovery is due and ENQUEUES it (every long-running activity is a queue job; the
// `cron-enqueue-only` conformance suite scans this file). The scan and the per-object re-queue are
// `media.storage.recover_stuck` (`StorageRecoveryHandler`). The jobs port's `enqueueHousekeeping` skips the
// tick when a job of the type is already pending or running, queues a system job at the housekeeping
// priority, and never throws.
//
// `STORAGE_PROCESSING_STUCK_RESET_ENABLED=false` turns the cron off (the admin endpoint still works).
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';
import { STORAGE_RECOVER_STUCK_TYPE } from './storage-recovery-types.js';

/**
 * Enqueues the stuck storage object recovery every ten minutes.
 *
 * @stability experimental
 */
@Injectable()
export class StorageRecoveryTask {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  /** The ten-minute tick. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async enqueueRecovery(): Promise<void> {
    if (process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] === 'false') return;
    await this.enqueueHousekeepingJob();
  }

  /**
   * Asks the jobs port for the housekeeping job: the host checks that none is already pending or running,
   * queues a system job at the housekeeping priority and never throws.
   */
  private async enqueueHousekeepingJob(): Promise<void> {
    await this.jobs.enqueueHousekeeping({ type: STORAGE_RECOVER_STUCK_TYPE, what: 'stuck storage object recovery' });
  }
}
