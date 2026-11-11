import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JobReason } from '@prisma/client';
import { WorkflowTriggerService, jobTypeToDependency } from '@marinoscar/memoriahub-api/workflows';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../media-processing/events/object-processed.event';
import {
  ENRICHMENT_JOB_SETTLED_EVENT,
  EnrichmentJobSettledEvent,
} from '../../enrichment/events/enrichment-job-settled.event';

/**
 * Media Workflow Automation — on_media_enriched trigger listener (issue #142; RETRO-J9, #622).
 *
 * The web app's two upstream signals, bound to the slice's `WorkflowTriggerService` (which holds the
 * settlement decision, the loop protection notes and the `workflow_evaluate_item` enqueue):
 *   - OBJECT_PROCESSED_EVENT       -> the metadata-settled signal (upload-only).
 *   - ENRICHMENT_JOB_SETTLED_EVENT -> a per-producer (tags/faces/bursts/...) signal; ONLY for
 *     `reason === upload` (loop protection (1): every workflow-applied re-enqueue uses rerun/backfill).
 *
 * Never rethrows (modeled on MediaEnrichmentEnqueueListener).
 */
@Injectable()
export class WorkflowTriggerListener {
  private readonly logger = new Logger(WorkflowTriggerListener.name);

  constructor(private readonly trigger: WorkflowTriggerService) {}

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handleObjectProcessed(evt: ObjectProcessedEvent): Promise<void> {
    try {
      const media = await this.trigger.findItemOfObject(evt.storageObjectId);
      if (!media) return;
      await this.trigger.evaluateSettlement(media.id, media.circleId, 'metadata');
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

      await this.trigger.evaluateSettlement(evt.mediaItemId, evt.circleId, dep);
    } catch (err) {
      this.logger.error(
        `handleJobSettled failed for job ${evt.jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
