// =============================================================================
// Picture Enhancement Purge Scheduled Task
// =============================================================================
//
// Hourly cron that enqueues a global picture_enhancement_purge enrichment job
// when no such job is already pending or running. Mirrors TrashPurgeTask. Gated
// on ENRICHMENT_WORKER_ENABLED so only worker instances schedule the sweep.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PictureEnhancementPurgeTask {
  private readonly logger = new Logger(PictureEnhancementPurgeTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledPurge(): Promise<void> {
    // Only worker instances create/sweep staging objects.
    if ((process.env['ENRICHMENT_WORKER_ENABLED'] ?? 'true') === 'false') {
      return;
    }

    try {
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'picture_enhancement_purge',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `picture_enhancement_purge job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'picture_enhancement_purge',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100,
      });

      this.logger.log('picture_enhancement_purge job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('picture_enhancement_purge schedule check failed', err as Error);
    }
  }
}
