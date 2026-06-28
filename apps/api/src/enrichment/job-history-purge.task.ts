// =============================================================================
// Job History Purge Scheduled Task
// =============================================================================
//
// Nightly cron that enqueues a job_history_purge enrichment job when no such job
// is already pending or running. Skips entirely when purging is disabled via the
// jobs.history.purgeEnabled system setting. Mirrors TrashPurgeTask.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from './enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

@Injectable()
export class JobHistoryPurgeTask {
  private readonly logger = new Logger(JobHistoryPurgeTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledPurge(): Promise<void> {
    try {
      const enabled =
        (await this.systemSettings.getSettingValue<boolean>('jobs.history.purgeEnabled')) ?? true;

      if (!enabled) {
        this.logger.debug('job_history_purge disabled; skipping schedule check');
        return;
      }

      // Skip if a job_history_purge job is already pending or running
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'job_history_purge',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `job_history_purge job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'job_history_purge',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100, // low priority — background purge
      });

      this.logger.log('job_history_purge job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('job_history_purge schedule check failed', err as Error);
    }
  }
}
