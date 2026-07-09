// =============================================================================
// Thumbnail Repair Scheduled Task
// =============================================================================
//
// Hourly cron that enqueues a thumbnail_repair enrichment job when no job is
// already pending or running. Mirrors TrashPurgeTask.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ThumbnailRepairTask {
  private readonly logger = new Logger(ThumbnailRepairTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledRepair(): Promise<void> {
    // Environment kill-switch (mirrors STORAGE_PROCESSING_STUCK_RESET_ENABLED)
    if (process.env['THUMBNAIL_REPAIR_ENABLED'] === 'false') {
      return;
    }

    try {
      // Skip if a thumbnail_repair job is already pending or running
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'thumbnail_repair',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `thumbnail_repair job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'thumbnail_repair',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100, // low priority — background repair sweep
      });

      this.logger.log('thumbnail_repair job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('thumbnail_repair schedule check failed', err as Error);
    }
  }
}
