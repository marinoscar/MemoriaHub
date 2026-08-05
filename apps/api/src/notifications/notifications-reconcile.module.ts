import { Module } from '@nestjs/common';

import { MediaModule } from '../media/media.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from './notifications.module';
import { NotificationReconcileTask } from './notification-reconcile.task';
import { EnrichmentFailureNotificationListener } from './producers/enrichment-failure-notification.listener';
import { ShareExpiringService } from './producers/share-expiring.service';
import { ShareExpiringTask } from './producers/share-expiring.task';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

/**
 * SELF-DRIVEN notification producers — crons and event listeners nobody
 * injects (epic #240, issues #246 + #247).
 *
 *   #246  ReviewQueueReconcileService + NotificationReconcileTask
 *           hourly review-queue STATE reconcile.
 *   #247  ShareExpiringService + ShareExpiringTask
 *           daily `share_expiring` sweep.
 *   #247  EnrichmentFailureNotificationListener
 *           `enrichment_failed`, off ENRICHMENT_JOB_SETTLED_EVENT.
 *
 * Kept SEPARATE from NotificationsModule on purpose. NotificationsModule owns
 * the table's write path and is imported BY producers; this module imports
 * MediaModule (for MediaService.computeReviewCounts) and would therefore turn
 * #247's `MediaModule -> NotificationsModule` producer edge (upload_completed)
 * into a module cycle if the two lived together. With the split, every edge
 * points the same way:
 *
 *   NotificationsReconcileModule -> MediaModule    -> NotificationsModule
 *   NotificationsReconcileModule -> WorkflowsModule?  (no — see below)
 *                                   WorkflowsModule -> NotificationsModule
 *
 * The #247 producers hosted here are the two that need NO extra module: the
 * share sweep uses only PrismaService + NotificationsService, and the
 * enrichment listener subscribes to a plain event-name constant rather than
 * injecting anything from EnrichmentModule — so neither adds an import edge,
 * and in particular this module never imports EnrichmentModule or
 * WorkflowsModule.
 *
 * SettingsModule supplies SystemSettingsService for #246's once-per-sweep
 * cached feature-flag read. PrismaModule is not imported — PrismaService is
 * @Global. EventEmitterModule.forRoot() in AppModule is what makes @OnEvent
 * work here, exactly as it does for WorkflowTriggerListener.
 *
 * The @Cron decorators work via ScheduleModule.forRoot() in AppModule, same as
 * TrashPurgeTask and ThumbnailRepairTask.
 */
@Module({
  imports: [NotificationsModule, MediaModule, SettingsModule],
  providers: [
    ReviewQueueReconcileService,
    NotificationReconcileTask,
    ShareExpiringService,
    ShareExpiringTask,
    EnrichmentFailureNotificationListener,
  ],
  exports: [ReviewQueueReconcileService, ShareExpiringService],
})
export class NotificationsReconcileModule {}
