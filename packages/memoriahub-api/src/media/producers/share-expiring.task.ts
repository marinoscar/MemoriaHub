// =============================================================================
// Expiring-Share Notification Scheduled Task (epic #240, issue #247; enqueue-only since RETRO-C9, #612;
// RETRO-J10 #624)
// =============================================================================
//
// Daily 9 AM cron that ENQUEUES `shares.expiring_sweep` (`ShareExpiringHandler`, which runs
// `ShareExpiringService.sweep()`). Root rule: every long-running activity is a queue job (the
// `cron-enqueue-only` conformance suite scans this file).
//
// `NOTIFICATIONS_SHARE_EXPIRING_ENABLED=false` stops the enqueue. The jobs port's `enqueueHousekeeping`
// skips the tick while a sweep is pending or running and never throws.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';
import { SHARE_EXPIRING_SWEEP_TYPE } from './share-expiring.constants.js';

/**
 * Enqueues the daily expiring-share sweep.
 *
 * @stability experimental
 */
@Injectable()
export class ShareExpiringTask {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  /** The daily tick. */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async handleScheduledSweep(): Promise<void> {
    // Environment kill-switch (mirrors NOTIFICATIONS_RECONCILE_ENABLED).
    if (process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'] === 'false') return;
    await this.enqueueHousekeepingJob();
  }

  /**
   * Asks the jobs port for the housekeeping job: the host checks that none is already pending or running,
   * queues a system job at the housekeeping priority and never throws.
   */
  private async enqueueHousekeepingJob(): Promise<void> {
    await this.jobs.enqueueHousekeeping({ type: SHARE_EXPIRING_SWEEP_TYPE, what: 'expiring-share notification sweep' });
  }
}
