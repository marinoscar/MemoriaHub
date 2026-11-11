// =============================================================================
// Picture Enhancement Purge Scheduled Task (enqueue-only)
// =============================================================================
//
// Hourly cron that enqueues the global `picture_enhancement_purge` job when none is already pending or
// running (`enqueueHousekeeping`: a system job at the housekeeping priority, never throws). Gated on the
// host's `housekeepingEnabled` so only worker instances schedule the sweep. The cron decides nothing
// else and works inline on nothing.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '../ports/index.js';
import { ENHANCEMENT_JOB_TYPES } from './constants.js';
import { ENHANCEMENT_OPTIONS, type EnhancementModuleOptions } from './enhancement-host-hooks.js';

/**
 * The hourly cron that enqueues `picture_enhancement_purge`.
 *
 * @stability experimental
 */
@Injectable()
export class PictureEnhancementPurgeTask {
  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Optional() @Inject(ENHANCEMENT_OPTIONS) private readonly options?: EnhancementModuleOptions,
  ) {}

  /** Enqueues the purge job on a worker instance. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledPurge(): Promise<void> {
    // Only worker instances create/sweep staging objects.
    if (this.options?.housekeepingEnabled?.() === false) return;
    await this.jobs.enqueueHousekeeping({
      type: ENHANCEMENT_JOB_TYPES.purge,
      what: 'picture enhancement purge',
    });
  }
}
