// =============================================================================
// Insights Refresh Task
// =============================================================================
//
// Interval-gated cron scheduler that enqueues a storage_insights enrichment
// job once the configured refresh interval has elapsed since the last
// computation. The `storage_insights` handler performs the actual computation.
//
// Enqueue-only (RETRO-C9, #612): the interval check reads, then
// `enqueueHousekeepingJob` queues the global system job at the housekeeping
// priority (100, as before) unless one is already pending or running, and never
// throws.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../ports/index.js';
import { InsightsService } from './insights.service.js';

/**
 * Enqueues the storage insights refresh once the configured interval has elapsed.
 *
 * @stability experimental
 */
@Injectable()
export class InsightsRefreshTask {
  private readonly logger = new Logger(InsightsRefreshTask.name);

  constructor(
    private readonly insights: InsightsService,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  /** The hourly tick. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledRefresh(): Promise<void> {
    try {
      const { value: storage } = await this.settings.readSystem<
        { insights?: { refreshIntervalHours?: number } } | undefined
      >('storage');
      const hours = storage?.insights?.refreshIntervalHours ?? 4;

      // Skip if a refresh is already queued or running — enqueue idempotency
      // also deduplicates, but checking first avoids log noise.
      const refresh = await this.insights.getRefreshState();
      if (refresh.state === 'pending' || refresh.state === 'running') {
        this.logger.debug(`Storage insights refresh already ${refresh.state}; skipping schedule check`);
        return;
      }

      const latest = await this.insights.getLatest();
      if (
        latest?.computedAt &&
        Date.now() - new Date(latest.computedAt).getTime() < hours * 3_600_000
      ) {
        return;
      }

      await this.jobs.enqueueHousekeeping({ type: 'storage_insights', what: 'storage insights refresh' });
    } catch (err) {
      this.logger.error('Storage insights schedule check failed', err as Error);
    }
  }
}
