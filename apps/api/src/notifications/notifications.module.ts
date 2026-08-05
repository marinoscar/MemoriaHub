import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { UploadNotificationService } from './producers/upload-notification.service';
import { WorkflowRunNotificationService } from './producers/workflow-run-notification.service';

/**
 * Notification Center (epic #240, issues #245 + #247).
 *
 * PrismaModule is deliberately NOT imported — it is @Global, so PrismaService
 * is injectable here without it.
 *
 * THIS MODULE IMPORTS NOTHING, and that is load-bearing. It is imported BY
 * producers (MediaModule, WorkflowsModule, NotificationsReconcileModule), so
 * every producer edge points INTO it. Adding an import here of any module that
 * transitively reaches MediaModule or WorkflowsModule would close a cycle.
 * That is why #246's review-queue reconcile (which needs MediaService) lives in
 * the separate NotificationsReconcileModule, and why the two producer services
 * below — the only #247 producers that another module has to INJECT — depend on
 * nothing but PrismaService and NotificationsService.
 *
 * Exports:
 *   - NotificationsService — the single write path for the notifications table
 *     (emit / upsertCountedEvent / upsertState). Producers call it rather than
 *     touching Prisma directly.
 *   - UploadNotificationService — injected by MediaService (`upload_completed`).
 *   - WorkflowRunNotificationService — injected by the workflow run handlers
 *     (`workflow_run_completed`).
 *
 * The other two #247 producers are self-driven (a cron and an event listener),
 * so nobody injects them and they live in NotificationsReconcileModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    UploadNotificationService,
    WorkflowRunNotificationService,
  ],
  exports: [
    NotificationsService,
    UploadNotificationService,
    WorkflowRunNotificationService,
  ],
})
export class NotificationsModule {}
