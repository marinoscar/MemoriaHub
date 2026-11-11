// =============================================================================
// Thumbnail Repair Scheduled Task (enqueue-only)
// =============================================================================
//
// Hourly cron that enqueues the global `thumbnail_repair` job when none is
// already pending or running (`enqueueHousekeeping`: system job, housekeeping
// priority 100, never throws). `THUMBNAIL_REPAIR_ENABLED=false` stops the enqueue.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../../ports/index.js';

/**
 * Enqueues the hourly thumbnail repair sweep.
 *
 * @stability experimental
 */
@Injectable()
export class ThumbnailRepairTask {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  /** The hourly tick. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledRepair(): Promise<void> {
    // Environment kill-switch (mirrors STORAGE_PROCESSING_STUCK_RESET_ENABLED)
    if (process.env['THUMBNAIL_REPAIR_ENABLED'] === 'false') return;
    await this.jobs.enqueueHousekeeping({ type: 'thumbnail_repair', what: 'thumbnail repair' });
  }
}
