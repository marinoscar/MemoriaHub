// =============================================================================
// Insights Refresh Task
// =============================================================================
//
// Interval-gated cron scheduler that enqueues a storage_insights enrichment
// job once the configured refresh interval has elapsed since the last
// computation. The enrichment worker performs the actual computation.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason } from '@prisma/client';
import { InsightsService } from './insights.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

@Injectable()
export class InsightsRefreshTask {
  private readonly logger = new Logger(InsightsRefreshTask.name);

  constructor(
    private readonly insights: InsightsService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledRefresh(): Promise<void> {
    try {
      const hours =
        (await this.systemSettings.getSettingValue<number>(
          'storage.insights.refreshIntervalHours',
        )) ?? 4;

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

      await this.insights.enqueueRefresh(JobReason.backfill, 100); // low priority
      this.logger.log('Storage insights refresh enqueued (scheduled)');
    } catch (err) {
      this.logger.error('Storage insights schedule check failed', err as Error);
    }
  }
}
