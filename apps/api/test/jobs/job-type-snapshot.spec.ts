/**
 * Job type snapshot (RETRO-C1, #575): "job type strings are permanent".
 *
 * Rows of every type below exist in production history (`jobs.type`), and the
 * type string is what a worker dispatches on, so a handler may be re-homed or
 * rewritten but its string never changes and never disappears. The spec pins:
 *
 *   - the 38 type strings the app registers,
 *   - which of them are node-eligible (a handler that carries BOTH
 *     `nodeResultSchema` and `persistNodeResult`; eligibility is derived,
 *     there is no flag), and
 *   - which carry the `canDelete` admin-delete veto.
 *
 * It instantiates every real handler class (the constructors are pure DI
 * assignment, so a no-arg construction is safe) and reads the same values the
 * queue reads. Cutover proof: the same expectations hold before and after the
 * platform adapter, because the adapter forwards the node pair only when the
 * legacy handler has both.
 */

import { EnrichmentHandlerRegistry } from '../../src/enrichment/enrichment-handler.registry';
import type { EnrichmentHandler } from '../../src/enrichment/enrichment-handler.interface';

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
import { JobHistoryPurgeHandler } from '../../src/enrichment/job-history-purge.handler';
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

/** Every handler class the app registers, one per job type. */
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
  JobHistoryPurgeHandler,
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

/** Types whose handler carries the node-result pair. */
export const EXPECTED_NODE_ELIGIBLE_TYPES = [
  'auto_tagging',
  'duplicate_detection',
  'face_detection',
  'geocode',
  'metadata_extraction',
  'social_media_detection',
  'thumbnail_regen',
  'thumbnail_repair',
  'video_auto_tagging',
  'video_face_detection',
  'workflow_execute_batch',
];

/** Types whose handler vetoes an admin delete of a non-terminal row. */
export const EXPECTED_CAN_DELETE_TYPES = [
  'broadcast_chunk',
  'broadcast_start',
];

describe('job type snapshot (job type strings are permanent)', () => {
  let handlers: EnrichmentHandler[];
  let registry: EnrichmentHandlerRegistry;

  beforeEach(() => {
    registry = new EnrichmentHandlerRegistry();
    handlers = ALL_HANDLER_CLASSES.map(
      (HandlerClass) => new (HandlerClass as unknown as new () => EnrichmentHandler)(),
    );
    for (const handler of handlers) registry.register(handler);
  });

  it('registers exactly the 38 pinned type strings', () => {
    expect(ALL_HANDLER_CLASSES).toHaveLength(38);
    expect(registry.types().sort()).toEqual([...EXPECTED_JOB_TYPES].sort());
  });

  it('has no duplicate type string', () => {
    const types = handlers.map((handler) => handler.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('pins the node-eligible types (node-result pair present)', () => {
    const eligible = handlers
      .filter((handler) => handler.nodeResultSchema && typeof handler.persistNodeResult === 'function')
      .map((handler) => handler.type)
      .sort();
    expect(eligible).toEqual([...EXPECTED_NODE_ELIGIBLE_TYPES].sort());
  });

  it('derives the server-only set as the complement of the node-eligible set', () => {
    const serverOnly = registry.serverOnlyTypes().sort();
    const expected = EXPECTED_JOB_TYPES.filter((type) => !EXPECTED_NODE_ELIGIBLE_TYPES.includes(type)).sort();
    expect(serverOnly).toEqual(expected);
  });

  it('never carries only half of the node-result pair', () => {
    for (const handler of handlers) {
      const hasSchema = handler.nodeResultSchema !== undefined;
      const hasPersist = typeof handler.persistNodeResult === 'function';
      expect({ type: handler.type, hasSchema }).toEqual({ type: handler.type, hasSchema: hasPersist });
    }
  });

  it('pins the canDelete veto types', () => {
    const vetoes = handlers
      .filter((handler) => typeof handler.canDelete === 'function')
      .map((handler) => handler.type)
      .sort();
    expect(vetoes).toEqual([...EXPECTED_CAN_DELETE_TYPES].sort());
  });
});
