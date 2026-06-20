// =============================================================================
// Insights Refresh Task
// =============================================================================
//
// Interval-gated cron that recomputes the storage insights snapshot once
// the configured refresh interval has elapsed since the last computation.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

      const latest = await this.insights.getLatest();
      if (
        latest?.computedAt &&
        Date.now() - new Date(latest.computedAt).getTime() < hours * 3_600_000
      ) {
        return;
      }

      await this.insights.recompute();
      this.logger.log('Storage insights snapshot refreshed');
    } catch (err) {
      this.logger.error('Storage insights refresh failed', err as Error);
    }
  }
}
