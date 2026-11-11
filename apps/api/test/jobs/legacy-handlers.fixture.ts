/**
 * The legacy handler classes and the job type facts the cutover must not change
 * (RETRO-C1, #575). Shared by `job-type-snapshot.spec.ts` and `legacy-adapter.spec.ts`;
 * a plain module so importing it never runs a spec.
 */

import { AutoTaggingHandler, VideoAutoTaggingHandler } from '@marinoscar/memoriahub-api/tagging';
import { BurstDetectionHandler } from '@marinoscar/memoriahub-api/burst';
import { DuplicateConfidenceBackfillHandler, DuplicateDetectionHandler, DuplicateDetectionBatchHandler } from '@marinoscar/memoriahub-api/dedup';
import { FaceAutoArchiveSweepHandler, FaceDetectionHandler, VideoFaceDetectionHandler } from '@marinoscar/memoriahub-api/face';
import { GeocodeHandler } from '../../src/geo/geocode.handler';
import { RetiredJobTypeHandler } from '../../src/platform/jobs/retired-job-types';
import { LocationGroupRebuildHandler } from '@marinoscar/memoriahub-api/location';
import { LocationInferenceHandler } from '@marinoscar/memoriahub-api/location';
import { MemoryDigestHandler } from '@marinoscar/memoriahub-api/memories';
import { MemoryGenerationHandler } from '@marinoscar/memoriahub-api/memories';
import { MetadataExtractionHandler } from '@marinoscar/memoriahub-api/media';
import { PictureEnhancementHandler } from '../../src/enhancement/picture-enhancement.handler';
import { PictureEnhancementPurgeHandler } from '../../src/enhancement/picture-enhancement-purge.handler';
import {
  LocationSuggestionRunEvaluateHandler,
  LocationSuggestionRunExecuteBatchHandler,
  ReviewRunEvaluateHandler,
  ReviewRunExecuteBatchHandler,
} from '@marinoscar/memoriahub-api/review-runs';
import { ReviewRunsRetentionHandler } from '../../src/review-runs/review-runs-retention.handler';
import { SocialMediaDetectionHandler } from '@marinoscar/memoriahub-api/social-media';
import { StorageInsightsHandler } from '@marinoscar/memoriahub-api/insights';
import { RetiredStorageMigrationHandler } from '../../src/platform/jobs/retired-job-types';
import { ThumbnailRegenHandler } from '@marinoscar/memoriahub-api/media';
import { ThumbnailRepairHandler } from '@marinoscar/memoriahub-api/media';
import { StorageRecoveryHandler } from '../../src/media-processing/recovery/storage-recovery.handler';
import { StorageReprocessHandler } from '../../src/media-processing/recovery/storage-reprocess.handler';
import { TrashEmptyEvaluateHandler } from '@marinoscar/memoriahub-api/media';
import { TrashEmptyExecuteBatchHandler } from '@marinoscar/memoriahub-api/media';
import { TrashPurgeHandler } from '@marinoscar/memoriahub-api/media';
import {
  WorkflowEvaluateHandler,
  WorkflowEvaluateItemHandler,
  WorkflowExecuteBatchHandler,
  WorkflowMicroRunFinalizeHandler,
  WorkflowScheduleTickHandler,
} from '@marinoscar/memoriahub-api/workflows';
import { WorkflowRunsRetentionHandler } from '../../src/workflows/runs/workflow-runs-retention.handler';
import { ReviewQueueReconcileHandler } from '../../src/notification-producers/review-queue-reconcile.handler';
import { ShareExpiringHandler } from '../../src/notification-producers/share-expiring.handler';
import { NodeBackupStaleHandler } from '../../src/node-backup/node-backup-stale.handler';

/**
 * Every handler class the app registers, one per job type.
 *
 * Since RETRO-C3 (#585) six of them are native platform `JobHandler`s
 * (`face_detection`, `video_face_detection`, `face_auto_archive_sweep`,
 * `metadata_extraction`, `thumbnail_regen`, `thumbnail_repair`) that register
 * with `JobHandlerRegistry` themselves; RETRO-C5 (#594) added the five
 * dedup/burst/social types (`duplicate_detection`, `duplicate_detection_batch`,
 * `duplicate_confidence_backfill`, `burst_detection`, `social_media_detection`); RETRO-C4 (#590) the four AI-bound
 * types (`auto_tagging`, `video_auto_tagging`, `picture_enhancement`, `picture_enhancement_purge`). They keep `type`, the node pair and
 * `canDelete` as plain members, so the snapshot reads the same facts off them.
 */
export const ALL_HANDLER_CLASSES = [
  AutoTaggingHandler,
  BurstDetectionHandler,
  DuplicateConfidenceBackfillHandler,
  DuplicateDetectionHandler,
  DuplicateDetectionBatchHandler,
  FaceAutoArchiveSweepHandler,
  FaceDetectionHandler,
  GeocodeHandler,
  RetiredJobTypeHandler,
  LocationGroupRebuildHandler,
  LocationInferenceHandler,
  LocationSuggestionRunEvaluateHandler,
  LocationSuggestionRunExecuteBatchHandler,
  MemoryDigestHandler,
  MemoryGenerationHandler,
  MetadataExtractionHandler,
  PictureEnhancementHandler,
  PictureEnhancementPurgeHandler,
  ReviewRunEvaluateHandler,
  ReviewRunExecuteBatchHandler,
  ReviewRunsRetentionHandler,
  SocialMediaDetectionHandler,
  StorageInsightsHandler,
  RetiredStorageMigrationHandler,
  ThumbnailRegenHandler,
  ThumbnailRepairHandler,
  TrashEmptyEvaluateHandler,
  TrashEmptyExecuteBatchHandler,
  TrashPurgeHandler,
  VideoAutoTaggingHandler,
  VideoFaceDetectionHandler,
  WorkflowEvaluateHandler,
  WorkflowEvaluateItemHandler,
  WorkflowExecuteBatchHandler,
  WorkflowRunsRetentionHandler,
  // RETRO-D1b (#567): the storage processing recovery and the admin bulk reprocess.
  StorageRecoveryHandler,
  StorageReprocessHandler,
  // RETRO-C9 (#612): the work of the crons that now only enqueue.
  WorkflowScheduleTickHandler,
  WorkflowMicroRunFinalizeHandler,
  ReviewQueueReconcileHandler,
  ShareExpiringHandler,
  NodeBackupStaleHandler,
];

/** The 42 permanent type strings with an app handler (RETRO-D3 retired three more: see below; RETRO-D1b added the two `media.storage.*`; RETRO-C9 the five cron job types). */
export const EXPECTED_JOB_TYPES = [
  'auto_tagging',
  'burst_detection',
  'duplicate_confidence_backfill',
  'duplicate_detection',
  'duplicate_detection_batch',
  'face_auto_archive_sweep',
  'face_detection',
  'geocode',
  'job_history_purge',
  'location_group_rebuild',
  'location_inference',
  'media.storage.recover_stuck',
  'media.storage.reprocess',
  'node_backup.stale_sweep',
  'notifications.review_queue_reconcile',
  'shares.expiring_sweep',
  'workflows.micro_run_finalize',
  'workflows.schedule_tick',
  'location_suggestion_run_evaluate',
  'location_suggestion_run_execute_batch',
  'memory_digest',
  'memory_generation',
  'metadata_extraction',
  'picture_enhancement',
  'picture_enhancement_purge',
  'review_run_evaluate',
  'review_run_execute_batch',
  'review_run_history_purge',
  'social_media_detection',
  'storage_insights',
  'storage_migration',
  'thumbnail_regen',
  'thumbnail_repair',
  'trash_empty_evaluate',
  'trash_empty_execute_batch',
  'trash_purge',
  'video_auto_tagging',
  'video_face_detection',
  'workflow_evaluate',
  'workflow_evaluate_item',
  'workflow_execute_batch',
  'workflow_history_purge',
];

/**
 * Types whose handler carries the node-result pair.
 *
 * `thumbnail_repair` left this list in RETRO-C3: it carried the schema only "for
 * interface parity" and was never claimable (a global sweep; the system worker
 * mode pinned it). Its documented eligibility is unchanged: server-only.
 */
export const EXPECTED_NODE_ELIGIBLE_TYPES = [
  'duplicate_detection',
  'face_detection',
  'geocode',
  'metadata_extraction',
  'social_media_detection',
  'thumbnail_regen',
  'video_face_detection',
  'workflow_execute_batch',
];

/** Types whose handler vetoes an admin delete of a non-terminal row. */
export const EXPECTED_CAN_DELETE_TYPES = [
  // RETRO-C7: a pending evaluate/execute-batch job of an active run is the
  // only thing that moves the run on.
  // RETRO-C4: a pending enhancement job of an active batch.
  'picture_enhancement',
  'review_run_evaluate',
  'review_run_execute_batch',
  'trash_empty_evaluate',
  'trash_empty_execute_batch',
  'workflow_evaluate',
  'workflow_execute_batch',
];

/**
 * RETRO-D3 (#576): the platform notifications slice replaced these; they still
 * dispatch, as no-ops (`platform/notifications/retired-notification-job-types.ts`).
 */
export const EXPECTED_RETIRED_NOTIFICATION_TYPES = ['broadcast_chunk', 'broadcast_start', 'notification_purge'];
