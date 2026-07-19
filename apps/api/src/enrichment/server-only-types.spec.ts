/**
 * Drift guard for the ENRICHMENT_WORKER_MODE=system claim set (issue #108).
 *
 * The system-mode eligibility set is DERIVED at runtime from the real handler
 * classes: EnrichmentHandlerRegistry.serverOnlyTypes() picks every handler
 * lacking the node-result pair (nodeResultSchema + persistNodeResult), and
 * systemModeEligibleTypes() adds 'thumbnail_repair' explicitly (its handler
 * carries a nodeResultSchema for interface parity, but the job is a global
 * sweep that is not end-to-end node-claimable).
 *
 * This spec instantiates every REAL handler class (all constructors are pure
 * DI assignment, so no-arg instantiation is safe) and asserts the derived set
 * equals the documented list — so adding/removing a handler, or adding the
 * node-result pair to an existing one, fails this test until the documented
 * expectation (and the CLAUDE.md / spec docs) are consciously updated.
 */

import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentHandler } from './enrichment-handler.interface';
import { systemModeEligibleTypes } from './enrichment-job.worker';

import { BurstDetectionHandler } from '../burst/burst-detection.handler';
import { DuplicateDetectionHandler } from '../dedup/duplicate-detection.handler';
import { DuplicateDetectionBatchHandler } from '../dedup/duplicate-detection-batch.handler';
import { JobHistoryPurgeHandler } from './job-history-purge.handler';
import { FaceAutoArchiveSweepHandler } from '../face/face-auto-archive-sweep.handler';
import { FaceDetectionHandler } from '../face/face-detection.handler';
import { VideoFaceDetectionHandler } from '../face/video-face-detection.handler';
import { GeocodeHandler } from '../geo/geocode.handler';
import { StorageInsightsHandler } from '../insights/storage-insights.handler';
import { LocationInferenceHandler } from '../location-inference/location-inference.handler';
import { MetadataExtractionHandler } from '../metadata/metadata.handler';
import { SocialMediaDetectionHandler } from '../social-media/social-media-detection.handler';
import { StorageMigrationHandler } from '../storage-settings/storage-migration.handler';
import { AutoTaggingHandler } from '../tagging/auto-tagging.handler';
import { ThumbnailRegenHandler } from '../media/thumbnail-regen.handler';
import { ThumbnailRepairHandler } from '../media/thumbnail-repair.handler';
import { TrashPurgeHandler } from '../media/trash-purge.handler';
import { WorkflowEvaluateItemHandler } from '../workflows/runs/workflow-evaluate-item.handler';
import { WorkflowEvaluateHandler } from '../workflows/runs/workflow-evaluate.handler';
import { WorkflowExecuteBatchHandler } from '../workflows/runs/workflow-execute-batch.handler';
import { WorkflowHistoryPurgeHandler } from '../workflows/runs/workflow-history-purge.handler';

/** Every registered enrichment handler class (keep in sync with the modules). */
const ALL_HANDLER_CLASSES = [
  BurstDetectionHandler,
  DuplicateDetectionHandler,
  DuplicateDetectionBatchHandler,
  JobHistoryPurgeHandler,
  FaceAutoArchiveSweepHandler,
  FaceDetectionHandler,
  VideoFaceDetectionHandler,
  GeocodeHandler,
  StorageInsightsHandler,
  LocationInferenceHandler,
  MetadataExtractionHandler,
  SocialMediaDetectionHandler,
  StorageMigrationHandler,
  AutoTaggingHandler,
  ThumbnailRegenHandler,
  ThumbnailRepairHandler,
  TrashPurgeHandler,
  WorkflowEvaluateItemHandler,
  WorkflowEvaluateHandler,
  WorkflowExecuteBatchHandler,
  WorkflowHistoryPurgeHandler,
];

/**
 * Documented server-only types — handlers WITHOUT nodeResultSchema /
 * persistNodeResult. Mirrors CLAUDE.md and docs/specs/distributed-nodes.md.
 */
const DOCUMENTED_SERVER_ONLY_TYPES = [
  'burst_detection',
  'duplicate_detection_batch',
  'face_auto_archive_sweep',
  'job_history_purge',
  'location_inference',
  'storage_insights',
  'storage_migration',
  'trash_purge',
  'workflow_evaluate',
  'workflow_evaluate_item',
  'workflow_history_purge',
];

/**
 * Documented system-mode claim set = server-only PLUS the two explicitly-pinned
 * node-schema-bearing types (`thumbnail_repair` — global sweep; and
 * `workflow_execute_batch` — issue #144, node-eligible but must stay
 * server-claimable so a `system`-mode deployment can run workflows without a
 * fleet). See systemModeEligibleTypes().
 */
const DOCUMENTED_SYSTEM_MODE_TYPES = [
  ...DOCUMENTED_SERVER_ONLY_TYPES,
  'thumbnail_repair',
  'workflow_execute_batch',
].sort();

describe('server-only type derivation (drift guard)', () => {
  let registry: EnrichmentHandlerRegistry;

  beforeEach(() => {
    registry = new EnrichmentHandlerRegistry();
    // Handler constructors are pure DI assignment — safe to instantiate with
    // no args; the type / nodeResultSchema instance fields still initialize.
    for (const HandlerClass of ALL_HANDLER_CLASSES) {
      const instance = new (HandlerClass as unknown as new () => EnrichmentHandler)();
      registry.register(instance);
    }
  });

  it('registers all known handler types', () => {
    expect(registry.types()).toHaveLength(ALL_HANDLER_CLASSES.length);
  });

  it('derives EXACTLY the documented server-only set from the real handlers', () => {
    expect(registry.serverOnlyTypes().sort()).toEqual(DOCUMENTED_SERVER_ONLY_TYPES);
  });

  it('systemModeEligibleTypes = documented server-only set + thumbnail_repair + workflow_execute_batch', () => {
    expect(systemModeEligibleTypes(registry, {}).sort()).toEqual(DOCUMENTED_SYSTEM_MODE_TYPES);
  });

  it('thumbnail_repair is node-schema-bearing (interface parity) yet still in the system-mode set', () => {
    // Precondition for the explicit inclusion: if this ever flips (the handler
    // loses its schema), serverOnlyTypes() would pick it up naturally and the
    // explicit add becomes a harmless no-op.
    expect(registry.serverOnlyTypes()).not.toContain('thumbnail_repair');
    expect(systemModeEligibleTypes(registry, {})).toContain('thumbnail_repair');
  });

  it('workflow_execute_batch is node-eligible (has the node-result pair) yet still in the system-mode set', () => {
    // Issue #144: the batch handler carries nodeResultSchema/persistNodeResult
    // so a node can claim it, so serverOnlyTypes() must NOT list it — but it is
    // explicitly pinned into the system-mode set so a `system`-mode deployment
    // can execute workflows without a fleet.
    expect(registry.serverOnlyTypes()).not.toContain('workflow_execute_batch');
    expect(systemModeEligibleTypes(registry, {})).toContain('workflow_execute_batch');
  });

  it('every node-eligible media compute type is EXCLUDED from the system-mode set', () => {
    const systemSet = new Set(systemModeEligibleTypes(registry, {}));
    for (const nodeType of [
      'face_detection',
      'video_face_detection',
      'auto_tagging',
      'geocode',
      'metadata_extraction',
      'social_media_detection',
      'duplicate_detection',
      'thumbnail_regen',
    ]) {
      expect(systemSet.has(nodeType)).toBe(false);
    }
  });
});
