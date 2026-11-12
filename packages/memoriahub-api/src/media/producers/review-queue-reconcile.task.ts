// =============================================================================
// Review-queue reconcile cron (epic #240, issue #246; RETRO-C9 #612; RETRO-J10 #624)
// =============================================================================
//
// Hourly. Decides only that the reconcile is due and ENQUEUES it (the `cron-enqueue-only` conformance
// suite scans this file): the work is `notifications.review_queue_reconcile`
// (`ReviewQueueReconcileHandler`). The jobs port's `enqueueHousekeeping` skips the tick when one is
// already pending or running and never throws. `NOTIFICATIONS_RECONCILE_ENABLED=false` turns it off.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';
import { REVIEW_QUEUE_RECONCILE_TYPE } from './review-queue.constants.js';

/**
 * Enqueues the hourly review-queue notification reconcile.
 *
 * @stability experimental
 */
@Injectable()
export class ReviewQueueReconcileTask {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  /** The hourly tick. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledReconcile(): Promise<void> {
    // Environment kill-switch (mirrors THUMBNAIL_REPAIR_ENABLED).
    if (process.env['NOTIFICATIONS_RECONCILE_ENABLED'] === 'false') return;
    await this.enqueueHousekeepingJob();
  }

  /**
   * Asks the jobs port for the housekeeping job: the host checks that none is already pending or running,
   * queues a system job at the housekeeping priority and never throws.
   */
  private async enqueueHousekeepingJob(): Promise<void> {
    await this.jobs.enqueueHousekeeping({ type: REVIEW_QUEUE_RECONCILE_TYPE, what: 'review-queue notification reconcile' });
  }
}
