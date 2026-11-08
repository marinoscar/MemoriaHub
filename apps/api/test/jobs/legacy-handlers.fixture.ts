/**
 * The legacy handler classes and the job type facts the cutover must not change
 * (RETRO-C1, #575). Shared by `job-type-snapshot.spec.ts` and `legacy-adapter.spec.ts`;
 * a plain module so importing it never runs a spec.
 */

import { AutoTaggingHandler } from '../../src/tagging/auto-tagging.handler';
import { BroadcastChunkHandler } from '../../src/notifications/broadcasts/handlers/broadcast-chunk.handler';
import { BroadcastStartHandler } from '../../src/notifications/broadcasts/handlers/broadcast-start.handler';
import { BurstDetectionHandler } from '../../src/burst/burst-detection.handler';
import { DuplicateConfidenceBackfillHandler } from '../../src/dedup/duplicate-confidence-backfill.handler';
import { DuplicateDetectionHandler } from '../../src/dedup/duplicate-detection.handler';
import { DuplicateDetectionBatchHandler } from '../../src/dedup/duplicate-detection-batch.handler';
import { FaceAutoArchiveSweepHandler } from '../../src/face/face-auto-archive-sweep.handler';
import { FaceDetectionHandler } from '../../src/face/face-detection.handler';
import { GeocodeHandler } from '../../src/geo/geocode.handler';
import { RetiredJobTypeHandler } from '../../src/platform/jobs/retired-job-types';
import { LocationGroupRebuildHandler } from '../../src/location-groups/location-group-rebuild.handler';
import { LocationInferenceHandler } from '../../src/location-inference/location-inference.handler';
import { LocationSuggestionRunEvaluateHandler } from '../../src/location-inference/runs/location-suggestion-run-evaluate.handler';
import { LocationSuggestionRunExecuteBatchHandler } from '../../src/location-inference/runs/location-suggestion-run-execute-batch.handler';
import { MemoryDigestHandler } from '../../src/memories/digest/memory-digest.handler';
import { MemoryGenerationHandler } from '../../src/memories/memory-generation.handler';
import { MetadataExtractionHandler } from '../../src/metadata/metadata.handler';
import { NotificationPurgeHandler } from '../../src/notifications/notification-purge.handler';
import { PictureEnhancementHandler } from '../../src/enhancement/picture-enhancement.handler';
import { PictureEnhancementPurgeHandler } from '../../src/enhancement/picture-enhancement-purge.handler';
import { ReviewRunEvaluateHandler } from '../../src/review-runs/review-run-evaluate.handler';
import { ReviewRunExecuteBatchHandler } from '../../src/review-runs/review-run-execute-batch.handler';
import { ReviewRunHistoryPurgeHandler } from '../../src/review-runs/review-run-history-purge.handler';
import { SocialMediaDetectionHandler } from '../../src/social-media/social-media-detection.handler';
import { StorageInsightsHandler } from '../../src/insights/storage-insights.handler';
import { StorageMigrationHandler } from '../../src/storage-settings/storage-migration.handler';
import { ThumbnailRegenHandler } from '../../src/media/thumbnail-regen.handler';
import { ThumbnailRepairHandler } from '../../src/media/thumbnail-repair.handler';
import { TrashEmptyEvaluateHandler } from '../../src/media/trash-empty/trash-empty-evaluate.handler';
import { TrashEmptyExecuteBatchHandler } from '../../src/media/trash-empty/trash-empty-execute-batch.handler';
import { TrashPurgeHandler } from '../../src/media/trash-purge.handler';
import { VideoAutoTaggingHandler } from '../../src/tagging/video-auto-tagging.handler';
import { VideoFaceDetectionHandler } from '../../src/face/video-face-detection.handler';
import { WorkflowEvaluateHandler } from '../../src/workflows/runs/workflow-evaluate.handler';
import { WorkflowEvaluateItemHandler } from '../../src/workflows/runs/workflow-evaluate-item.handler';
import { WorkflowExecuteBatchHandler } from '../../src/workflows/runs/workflow-execute-batch.handler';
import { WorkflowHistoryPurgeHandler } from '../../src/workflows/runs/workflow-history-purge.handler';

/**
 * Every handler class the app registers, one per job type.
 *
 * Since RETRO-C3 (#585) six of them are native platform `JobHandler`s
 * (`face_detection`, `video_face_detection`, `face_auto_archive_sweep`,
 * `metadata_extraction`, `thumbnail_regen`, `thumbnail_repair`) that register
 * with `JobHandlerRegistry` themselves. They keep `type`, the node pair and
 * `canDelete` as plain members, so the snapshot reads the same facts off them.
 */
export const ALL_HANDLER_CLASSES = [
  AutoTaggingHandler,
  BroadcastChunkHandler,
  BroadcastStartHandler,
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
  NotificationPurgeHandler,
  PictureEnhancementHandler,
  PictureEnhancementPurgeHandler,
  ReviewRunEvaluateHandler,
  ReviewRunExecuteBatchHandler,
  ReviewRunHistoryPurgeHandler,
  SocialMediaDetectionHandler,
  StorageInsightsHandler,
  StorageMigrationHandler,
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
  WorkflowHistoryPurgeHandler,
];

/** The 38 permanent type strings. */
export const EXPECTED_JOB_TYPES = [
  'auto_tagging',
  'broadcast_chunk',
  'broadcast_start',
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
  'location_suggestion_run_evaluate',
  'location_suggestion_run_execute_batch',
  'memory_digest',
  'memory_generation',
  'metadata_extraction',
  'notification_purge',
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
  'auto_tagging',
  'duplicate_detection',
  'face_detection',
  'geocode',
  'metadata_extraction',
  'social_media_detection',
  'thumbnail_regen',
  'video_auto_tagging',
  'video_face_detection',
  'workflow_execute_batch',
];

/** Types whose handler vetoes an admin delete of a non-terminal row. */
export const EXPECTED_CAN_DELETE_TYPES = [
  'broadcast_chunk',
  'broadcast_start',
];

