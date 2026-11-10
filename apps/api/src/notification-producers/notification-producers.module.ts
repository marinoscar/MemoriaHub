// =============================================================================
// MemoriaHub's notification producers (RETRO-D3, #576)
// =============================================================================
//
// The platform notifications slice (`platform/notifications/notifications.config.ts`,
// global) stores, streams, pushes and emails; the code here decides WHEN and to
// WHOM, and keeps each producer's volume guard (docs/specs/notifications.md).
//
// Two modules, so the module graph stays acyclic:
//   NotificationProducersModule  imports nothing; MediaModule (uploads) and
//                                WorkflowsModule (run finalize) import it.
//   NotificationReconcileModule  the self-driven producers: the hourly
//                                review-queue reconcile (needs MediaModule's
//                                computeReviewCounts), the daily share-expiry
//                                sweep and the enrichment-failure listener.
//                                Nobody imports it but AppModule.
// =============================================================================

import { Module } from '@nestjs/common';

import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { UploadNotificationService } from './upload-notification.service';
import { WorkflowRunNotificationService } from './workflow-run-notification.service';

@Module({
  // RETRO-K1: the scope directory (OwnerScopeSweepService); OwnerAccessModule imports nothing of the media graph.
  imports: [OwnerAccessModule],
  providers: [UploadNotificationService, WorkflowRunNotificationService],
  exports: [UploadNotificationService, WorkflowRunNotificationService],
})
export class NotificationProducersModule {}
