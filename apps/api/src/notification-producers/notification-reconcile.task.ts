// =============================================================================
// Review-Queue Notification Reconcile Scheduled Task (epic #240, issue #246;
// enqueue-only since RETRO-C9, #612)
// =============================================================================
//
// Hourly cron that ENQUEUES `notifications.review_queue_reconcile`, which
// re-states every circle's review-queue notifications against the real pending
// counts (`ReviewQueueReconcileHandler`). Root rule: every long-running
// activity is a queue job (`cron-enqueue-only` conformance suite).
//
// Deliberately NOT per-request and NOT per-upload. Producing a notification on
// every burst/duplicate/suggestion created is precisely the fan-out this
// feature exists to avoid — 929 pending duplicate groups must be ONE row whose
// count is 929, and a periodic reconcile is what guarantees that no matter how
// many (or how few) of the underlying events were observed.
//
// `NOTIFICATIONS_RECONCILE_ENABLED=false` stops the enqueue. The old in-process
// overlap guard is gone: `enqueueHousekeepingJob` skips the tick while a
// reconcile is pending or running, and the queue's dedup index closes the
// cross-replica race. Never throws.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobsService, enqueueHousekeepingJob } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { REVIEW_QUEUE_RECONCILE_TYPE } from './notification-cron-jobs.constants';

@Injectable()
export class NotificationReconcileTask {
  private readonly logger = new Logger(NotificationReconcileTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledReconcile(): Promise<void> {
    // Environment kill-switch (mirrors THUMBNAIL_REPAIR_ENABLED).
    if (process.env['NOTIFICATIONS_RECONCILE_ENABLED'] === 'false') return;
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: REVIEW_QUEUE_RECONCILE_TYPE,
      what: 'review-queue notification reconcile',
    });
  }
}
