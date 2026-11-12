import { Module } from '@nestjs/common';

import { ReviewQueueReconcileHandler, ReviewQueueReconcileService, ReviewQueueReconcileTask } from '@marinoscar/memoriahub-api/media';

import { MediaModule } from '../media/media.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { sharingModule } from '../platform/sharing/sharing.config';
import { RetiredNotificationJobTypes } from '../platform/notifications/retired-notification-job-types';
import { EnrichmentFailureNotificationListener } from './enrichment-failure-notification.listener';
import { ShareExpiringService } from './share-expiring.service';
import { ShareExpiringTask } from './share-expiring.task';
import { ShareExpiringHandler } from './share-expiring.handler';

/** The self-driven producers; see `notification-producers.module.ts`. */
@Module({
  imports: [MediaModule, sharingModule, OwnerAccessModule],
  providers: [
    ReviewQueueReconcileService,
    ReviewQueueReconcileTask,
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
