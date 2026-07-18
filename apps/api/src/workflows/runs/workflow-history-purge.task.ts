import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Media Workflow Automation — nightly run-history purge scheduler (issue #140).
 *
 * Enqueues a single global `workflow_history_purge` enrichment job when no such
 * job is already pending or running. Mirrors JobHistoryPurgeTask.
 */
@Injectable()
export class WorkflowHistoryPurgeTask {
  private readonly logger = new Logger(WorkflowHistoryPurgeTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledPurge(): Promise<void> {
    try {
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'workflow_history_purge',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });
      if (existing) {
        this.logger.debug(
          `workflow_history_purge job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'workflow_history_purge',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100,
      });

      this.logger.log('workflow_history_purge job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('workflow_history_purge schedule check failed', err as Error);
    }
  }
}
