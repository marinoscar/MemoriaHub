import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Review-run history purge scheduler (issue #190).
 *
 * Nightly cron that enqueues a single global `review_run_history_purge`
 * enrichment job when no such job is already pending or running — the same
 * dedup guard JobHistoryPurgeTask / WorkflowHistoryPurgeTask use, so a backed-up
 * queue never accumulates a pile of redundant purge jobs.
 *
 * The job itself sweeps stale non-terminal runs AND applies retention to
 * terminal ones across both `review_runs` and `trash_empty_runs`; see
 * ReviewRunHistoryPurgeHandler for why the stale sweep is a user-facing
 * lockout fix rather than housekeeping.
 */
@Injectable()
export class ReviewRunHistoryPurgeTask {
  private readonly logger = new Logger(ReviewRunHistoryPurgeTask.name);

  constructor(
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledPurge(): Promise<void> {
    try {
      const existing = await this.prisma.enrichmentJob.findFirst({
        where: {
          type: 'review_run_history_purge',
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });

      if (existing) {
        this.logger.debug(
          `review_run_history_purge job already ${existing.status}; skipping schedule check`,
        );
        return;
      }

      await this.enrichmentJobService.enqueue({
        type: 'review_run_history_purge',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100, // low priority — background purge
      });

      this.logger.log('review_run_history_purge job enqueued (scheduled)');
    } catch (err) {
      this.logger.error('review_run_history_purge schedule check failed', err as Error);
    }
  }
}
