// =============================================================================
// Notification Purge Scheduled Task (epic #240, issue #248)
// =============================================================================
//
// Nightly cron that enqueues a global `notification_purge` enrichment job when
// no such job is already pending or running. Skips entirely when purging is
// disabled via the notifications.purgeEnabled system setting. Mirrors
// JobHistoryPurgeTask exactly — same midnight schedule, same dedup guard (so a
// backed-up queue never accumulates a pile of redundant purge jobs), same
// never-throw error handling.
//
// Unlike NotificationReconcileTask (#246), which does its hourly work IN
// PROCESS, this one goes through the enrichment queue: the sweep is an
// unbounded batched DELETE over the whole notifications table, and the queue is
// what supplies retries, /admin/jobs visibility and the single-runner guarantee
// that a raw cron in a multi-replica deployment does not.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

@Injectable()
export class NotificationPurgeTask {
  private readonly logger = new Logger(NotificationPurgeTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledPurge(): Promise<void> {
    try {
      const enabled =
        (await this.systemSettings.getSettingValue<boolean>('notifications.purgeEnabled')) ?? true;

      if (!enabled) {
        this.logger.debug('notification_purge disabled; skipping schedule check');
        return;
      }

      // Skip if a notification_purge job is already pending or running
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'notification_purge',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `notification_purge job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'notification_purge',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100, // low priority — background purge
      });

      this.logger.log('notification_purge job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('notification_purge schedule check failed', err as Error);
    }
  }
}
