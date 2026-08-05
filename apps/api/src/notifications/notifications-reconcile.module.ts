import { Module } from '@nestjs/common';

import { MediaModule } from '../media/media.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from './notifications.module';
import { NotificationReconcileTask } from './notification-reconcile.task';
import { ReviewQueueReconcileService } from './review-queue-reconcile.service';

/**
 * Review-queue notification producer (epic #240, issue #246).
 *
 * Kept SEPARATE from NotificationsModule on purpose. NotificationsModule owns
 * the table's write path and is imported BY producers; this module imports
 * MediaModule (for MediaService.computeReviewCounts) and would therefore turn
 * the very first `MediaModule -> NotificationsModule` producer edge (#247's
 * upload_completed / enrichment_failed events) into a module cycle if the two
 * lived together. With the split, both edges point the same way:
 *
 *   NotificationsReconcileModule -> MediaModule -> NotificationsModule
 *
 * SettingsModule supplies SystemSettingsService for the once-per-sweep cached
 * feature-flag read. PrismaModule is not imported — PrismaService is @Global.
 *
 * NotificationReconcileTask's @Cron works via ScheduleModule.forRoot() in
 * AppModule, same as TrashPurgeTask and ThumbnailRepairTask.
 */
@Module({
  imports: [NotificationsModule, MediaModule, SettingsModule],
  providers: [ReviewQueueReconcileService, NotificationReconcileTask],
  exports: [ReviewQueueReconcileService],
})
export class NotificationsReconcileModule {}
