import { Inject, Injectable, Logger } from '@nestjs/common';

import { enqueueEnrichmentJob } from '../../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import { WorkflowConditionCompiler } from '../compiler/workflow-condition.compiler.js';
import type { WorkflowsDb } from '../data/workflows-db.js';
import type { WorkflowDefinition } from '../definition/workflow-definition.schema.js';
import type { WorkflowDependency } from '../registry/field-descriptor.interface.js';
import { isWorkflowsEnabled, readWorkflowSettings, type ResolvedWorkflowSettings as ResolvedSettings } from '../settings/workflows-settings.js';
import { WORKFLOW_TRIGGER } from '../workflows.constants.js';
import { isFullySettled, type DependencyState } from './settlement-decision.js';

/** Enrichment job types whose in-flight presence blocks a producer's settlement. */
const IN_FLIGHT_PRODUCER_TYPES = [
  'burst_detection',
  'duplicate_detection',
  'location_inference',
  'face_detection',
  'video_face_detection',
];

/**
 * Map a settled enrichment job type to the workflow dependency it produces. */
export function jobTypeToDependency(type: string): WorkflowDependency | null {
  switch (type) {
    case 'auto_tagging':
      return 'tags';
    case 'face_detection':
    case 'video_face_detection':
      return 'faces';
    case 'burst_detection':
      return 'bursts';
    case 'duplicate_detection':
      return 'duplicates';
    case 'location_inference':
      return 'locationSuggestions';
    default:
      return null;
  }
}

/**
 * Media Workflow Automation — the on_media_enriched settlement service (issue #142; RETRO-J9, #622).
 *
 * The host-neutral half of the trigger listener. The host listens for its two upstream signals (a media item's
 * processing finished, an enrichment job settled for an upload) and calls {@link evaluateSettlement}; once the
 * item's enrichment dependencies are fully settled, this enqueues a per-workflow `workflow_evaluate_item` job.
 * `reasonSettles` and `jobTypeToDependency` carry the loop-protection decision the listener applies:
 *
 *  (1) The job-settled path fires ONLY for `reason === upload`. Every workflow-applied re-enqueue uses
 *      `rerun`/`backfill`, except `move_to_circle` (upload-reason enrichment in the TARGET circle: a legitimate
 *      fresh enrichment cycle, not a tight loop).
 *  (2) The object-processed signal is emitted only by the original upload/processing pipeline.
 *  (3) The `workflow_evaluate_item` evaluate-once guard (an item already has a run item on a run of the
 *      workflow) is the backstop for any residual re-fire.
 *
 * Never rethrows from its callers' point of view: the listener wraps every call.
 *
 * @extensionPoint service
 * @stability experimental
 */
@Injectable()
export class WorkflowTriggerService {
  private readonly logger = new Logger(WorkflowTriggerService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: WorkflowsDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settingsPort: MemoriahubSettingsPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    private readonly compiler: WorkflowConditionCompiler,
  ) {}

  /**
   * The media item a storage object belongs to, when it has one.
   *
   * @param storageObjectId - the processed storage object.
   */
  async findItemOfObject(storageObjectId: string): Promise<{ id: string; circleId: string } | null> {
    return (await this.prisma.mediaItem.findUnique({
      where: { storageObjectId },
      select: { id: true, circleId: true },
    })) as { id: string; circleId: string } | null;
  }

  /**
   * Core: gate on the feature/trigger, do ONE cheap indexed backpressure query
   * for candidate workflows, then (only if any exist) build the item's settlement
   * snapshot once and enqueue a per-workflow evaluate-item job for each workflow
   * whose dependencies are fully settled.
   */
  async evaluateSettlement(
    mediaItemId: string,
    circleId: string,
    settledDep: WorkflowDependency,
  ): Promise<void> {
    const settings = await readWorkflowSettings(this.settingsPort);
    if (!isWorkflowsEnabled(settings)) return;
    if (settings.workflows?.triggers?.onEnrichment === false) return;

    // Backpressure gate: the common bulk-import case (no on_media_enriched
    // workflow in the circle) costs exactly ONE indexed query per settled job
    // (served by the (circle_id, enabled) index) and returns here.
    const workflows = (await this.prisma.workflow.findMany({
      where: { circleId, enabled: true, trigger: WORKFLOW_TRIGGER.on_media_enriched },
      select: { id: true, definition: true },
    })) as Array<{ id: string; definition: unknown }>;
    if (workflows.length === 0) return;

    this.logger.debug(
      `Settlement check (dep=${settledDep}) for item ${mediaItemId} in circle ${circleId}: ${workflows.length} candidate workflow(s)`,
    );

    const state = await this.buildDependencyState(mediaItemId, settings);

    for (const wf of workflows) {
      let deps: Set<WorkflowDependency>;
      try {
        deps = new Set(
          this.compiler.deriveDependencies(wf.definition as unknown as WorkflowDefinition),
        );
      } catch {
        continue; // malformed definition — skip defensively
      }

      // A no-condition / empty-dependency workflow should still fire once, keyed
      // off the metadata (OBJECT_PROCESSED) signal.
      const effectiveDeps = deps.size === 0 ? new Set<WorkflowDependency>(['metadata']) : deps;

      // Dependency-aware: only react when the JUST-settled dependency is one this
      // workflow actually reads — otherwise a metadata-only workflow would enqueue
      // on every subsequent tag/face/burst/dup/location settlement (~6x redundant
      // per item during bulk import). This collapses the fan-out to ~1 enqueue:
      // the last-completing relevant dependency triggers it.
      if (!effectiveDeps.has(settledDep)) continue;
      if (!isFullySettled(effectiveDeps, state)) continue;

      // skipDedup: dedup is keyed on (type, mediaItemId) and would collapse the
      // second workflow's job for the same item; the evaluate-once guard +
      // (runId, mediaItemId) uniqueness provide idempotency instead.
      await enqueueEnrichmentJob(this.jobs, {
        type: 'workflow_evaluate_item',
        mediaItemId,
        circleId,
        reason: 'rerun',
        priority: 50,
        payload: { workflowId: wf.id, mediaItemId },
        skipDedup: true,
      });
    }
  }

  /**
   * Build the item's per-dependency settlement snapshot. "Terminal" for each
   * dependency includes the negative/absent outcomes so an item is never
   * stranded:
   *   - metadata: always true (OBJECT_PROCESSED fired for any settlement).
   *   - tags: feature off OR tag status processed/failed.
   *   - faces: feature off OR face status processed/failed/no_faces OR a
   *     social-media video with no face job still in flight.
   *   - bursts: feature off OR a burst group formed OR no burst job in flight.
   *   - duplicates: feature off OR a duplicate group formed OR no dup job in flight.
   *   - locationSuggestions: feature off OR a suggestion row exists OR no
   *     location_inference job in flight.
   */
  private async buildDependencyState(
    mediaItemId: string,
    settings: ResolvedSettings,
  ): Promise<DependencyState> {
    const features = settings.features ?? {};
    const tagsFeat = features['autoTagging'] === true;
    const faceFeat = features['faceRecognition'] === true;
    const burstFeat = features['burstDetection'] === true;
    const dupFeat = features['duplicateDetection'] === true;
    const locFeat = features['locationInference'] === true;

    const [item, tagStatus, faceStatus, locSuggestion, inFlightRows] = await Promise.all([
      this.prisma.mediaItem.findUnique({
        where: { id: mediaItemId },
        select: {
          type: true,
          burstGroupId: true,
          duplicateGroupId: true,
          socialMediaSource: true,
        },
      }),
      this.prisma.mediaTagStatus.findUnique({
        where: { mediaItemId },
        select: { status: true },
      }),
      this.prisma.mediaFaceStatus.findUnique({
        where: { mediaItemId },
        select: { status: true },
      }),
      this.prisma.locationSuggestion.findUnique({
        where: { mediaItemId },
        select: { id: true },
      }),
      this.prisma.job.findMany({
        where: {
          subjectType: 'media_item',
          subjectId: mediaItemId,
          type: { in: IN_FLIGHT_PRODUCER_TYPES },
          status: { in: ['pending', 'running'] },
        },
        select: { type: true },
      }),
    ]);

    const inFlight = inFlightRows as Array<{ type: string }>;
    const pending = new Set(inFlight.map((j) => j.type));

    const tags =
      !tagsFeat || tagStatus?.status === 'processed' || tagStatus?.status === 'failed';

    const faces =
      !faceFeat ||
      faceStatus?.status === 'processed' ||
      faceStatus?.status === 'failed' ||
      faceStatus?.status === 'no_faces' ||
      (item?.type === 'video' &&
        item?.socialMediaSource != null &&
        !pending.has('face_detection') &&
        !pending.has('video_face_detection'));

    const bursts =
      !burstFeat || item?.burstGroupId != null || !pending.has('burst_detection');

    const duplicates =
      !dupFeat || item?.duplicateGroupId != null || !pending.has('duplicate_detection');

    const locationSuggestions =
      !locFeat || locSuggestion != null || !pending.has('location_inference');

    return { metadata: true, tags, faces, bursts, duplicates, locationSuggestions };
  }
}
