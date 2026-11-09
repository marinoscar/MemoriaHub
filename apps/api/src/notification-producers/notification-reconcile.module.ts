import { Module } from '@nestjs/common';

import { MediaModule } from '../media/media.module';
import { RetiredNotificationJobTypes } from '../platform/notifications/retired-notification-job-types';
import { EnrichmentFailureNotificationListener } from './enrichment-failure-notification.listener';
import { NotificationReconcileTask } from './notification-reconcile.task';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';
import { ShareExpiringService } from './share-expiring.service';
import { ShareExpiringTask } from './share-expiring.task';
import { ReviewQueueReconcileHandler } from './review-queue-reconcile.handler';
import { ShareExpiringHandler } from './share-expiring.handler';

/** The self-driven producers; see `notification-producers.module.ts`. */
@Module({
  imports: [MediaModule],
  providers: [
    ReviewQueueReconcileService,
    NotificationReconcileTask,
    ShareExpiringService,
    ShareExpiringTask,
    EnrichmentFailureNotificationListener,
    // RETRO-C9 (#612): the two crons only enqueue; these do the work.
    ReviewQueueReconcileHandler,
    ShareExpiringHandler,
    // The three job types the platform slice replaced keep dispatching (no-op).
    RetiredNotificationJobTypes,
  ],
  exports: [ReviewQueueReconcileService, ShareExpiringService],
})
export class NotificationReconcileModule {}
