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

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';
import { PrismaService } from '../prisma/prisma.service';
import { InsightsService } from './insights.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

@Injectable()
export class InsightsRefreshTask {
  private readonly logger = new Logger(InsightsRefreshTask.name);

  constructor(
    private readonly insights: InsightsService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
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

      await enqueueHousekeepingJob({
        jobs: this.jobs,
        prisma: this.prisma,
        logger: this.logger,
        type: 'storage_insights',
        what: 'storage insights refresh',
      });
    } catch (err) {
      this.logger.error('Storage insights schedule check failed', err as Error);
    }
  }
}
