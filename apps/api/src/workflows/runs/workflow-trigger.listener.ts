import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JobReason, JobStatus, MediaType, WorkflowTrigger } from '@prisma/client';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../storage/processing/events/object-processed.event';
import {
  ENRICHMENT_JOB_SETTLED_EVENT,
  EnrichmentJobSettledEvent,
} from '../../enrichment/events/enrichment-job-settled.event';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { isWorkflowsEnabled } from '../../common/types/settings.types';
import { WorkflowConditionCompiler } from '../compiler/workflow-condition.compiler';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { WorkflowDependency } from '../registry/field-descriptor.interface';
import { DependencyState, isFullySettled } from './settlement-decision';

type ResolvedSettings = Awaited<ReturnType<SystemSettingsService['getSettings']>>;

/** Enrichment job types whose in-flight presence blocks a producer's settlement. */
const IN_FLIGHT_PRODUCER_TYPES = [
  'burst_detection',
  'duplicate_detection',
  'location_inference',
  'face_detection',
  'video_face_detection',
];

/** Map a settled enrichment job type to the workflow dependency it produces. */
function jobTypeToDependency(type: string): WorkflowDependency | null {
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
 * Media Workflow Automation — on_media_enriched trigger listener (issue #142).
 *
 * Reacts to two upstream signals and, once an item's enrichment dependencies are
 * fully settled, enqueues a per-workflow `workflow_evaluate_item` job:
 *   - OBJECT_PROCESSED_EVENT     → the metadata-settled signal (upload-only).
 *   - ENRICHMENT_JOB_SETTLED_EVENT → a per-producer (tags/faces/bursts/…) signal.
 *
 * ── Loop protection: how a first-upload settlement is distinguished from
 *    re-runs / workflow-applied mutations ─────────────────────────────────────
 *  (1) The ENRICHMENT_JOB_SETTLED path fires ONLY for `reason === upload`.
 *      Every workflow-applied re-enqueue uses `rerun`/`backfill`:
 *        - assign_person → auto_tagging rerun (reason=rerun),
 *        - rerun_enrichment → reason=rerun,
 *        - move_to_circle → MediaEnrichmentService.enqueueUploadEnrichment, which
 *          uses reason=UPLOAD in the TARGET circle. This is the one action that
 *          re-fires upload-reason enrichment, so a moved item CAN re-settle and
 *          trigger the target circle's on_media_enriched workflows — a legitimate
 *          fresh enrichment cycle in a new circle, NOT a tight loop.
 *  (2) The OBJECT_PROCESSED path is emitted only by the original upload/processing
 *      pipeline; metadata rerun deliberately does NOT emit it.
 *  (3) The workflow_evaluate_item handler's evaluate-once guard (the item already
 *      has a run item on a run of this workflow → skip) is the backstop that
 *      stops any residual re-fire — breaking workflow→enrichment→workflow
 *      cascades and mutual two-workflow loops (incl. the cross-circle
 *      move_to_circle case in (1)).
 *
 * Never rethrows (modeled on MediaEnrichmentEnqueueListener).
 */
@Injectable()
export class WorkflowTriggerListener {
  private readonly logger = new Logger(WorkflowTriggerListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly compiler: WorkflowConditionCompiler,
    private readonly enrichmentJobs: EnrichmentJobService,
  ) {}

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handleObjectProcessed(evt: ObjectProcessedEvent): Promise<void> {
    try {
      const media = await this.prisma.mediaItem.findUnique({
        where: { storageObjectId: evt.storageObjectId },
        select: { id: true, circleId: true },
      });
      if (!media) return;
      await this.evaluateSettlement(media.id, media.circleId, 'metadata');
    } catch (err) {
      this.logger.error(
        `handleObjectProcessed failed for StorageObject ${evt.storageObjectId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  @OnEvent(ENRICHMENT_JOB_SETTLED_EVENT, { async: true })
  async handleJobSettled(evt: EnrichmentJobSettledEvent): Promise<void> {
    try {
      // Loop protection (1): only original-upload enrichment re-settles workflows.
      if (evt.reason !== JobReason.upload) return;
      if (!evt.mediaItemId || !evt.circleId) return;

      const dep = jobTypeToDependency(evt.type);
      if (!dep) return; // not a workflow-relevant producer

      await this.evaluateSettlement(evt.mediaItemId, evt.circleId, dep);
    } catch (err) {
      this.logger.error(
        `handleJobSettled failed for job ${evt.jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Core: gate on the feature/trigger, do ONE cheap indexed backpressure query
   * for candidate workflows, then (only if any exist) build the item's settlement
   * snapshot once and enqueue a per-workflow evaluate-item job for each workflow
   * whose dependencies are fully settled.
   */
  private async evaluateSettlement(
    mediaItemId: string,
    circleId: string,
    settledDep: WorkflowDependency,
  ): Promise<void> {
    const settings = await this.systemSettings.getSettings();
    if (!isWorkflowsEnabled(settings)) return;
    if (settings.workflows?.triggers?.onEnrichment === false) return;

    // Backpressure gate: the common bulk-import case (no on_media_enriched
    // workflow in the circle) costs exactly ONE indexed query per settled job
    // (served by the (circle_id, enabled) index) and returns here.
    const workflows = await this.prisma.workflow.findMany({
      where: { circleId, enabled: true, trigger: WorkflowTrigger.on_media_enriched },
      select: { id: true, definition: true },
    });
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
      await this.enrichmentJobs.enqueue({
        type: 'workflow_evaluate_item',
        mediaItemId,
        circleId,
        reason: JobReason.rerun,
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

    const [item, tagStatus, faceStatus, locSuggestion, inFlight] = await Promise.all([
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
      this.prisma.enrichmentJob.findMany({
        where: {
          mediaItemId,
          type: { in: IN_FLIGHT_PRODUCER_TYPES },
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
        select: { type: true },
      }),
    ]);

    const pending = new Set(inFlight.map((j) => j.type));

    const tags =
      !tagsFeat || tagStatus?.status === 'processed' || tagStatus?.status === 'failed';

    const faces =
      !faceFeat ||
      faceStatus?.status === 'processed' ||
      faceStatus?.status === 'failed' ||
      faceStatus?.status === 'no_faces' ||
      (item?.type === MediaType.video &&
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
