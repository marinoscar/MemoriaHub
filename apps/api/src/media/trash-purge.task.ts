// =============================================================================
// Trash Purge Scheduled Task
// =============================================================================
//
// Hourly cron that enqueues a trash_purge enrichment job when no job is already
// pending or running. Mirrors InsightsRefreshTask.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TrashPurgeTask {
  private readonly logger = new Logger(TrashPurgeTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledPurge(): Promise<void> {
    try {
      // Skip if a trash_purge job is already pending or running
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'trash_purge',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `trash_purge job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'trash_purge',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100, // low priority — background purge
      });

      this.logger.log('trash_purge job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('trash_purge schedule check failed', err as Error);
    }
  }
}
