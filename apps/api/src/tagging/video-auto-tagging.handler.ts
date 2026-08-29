import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { videoAutoTaggingResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { AutoTaggingService } from './auto-tagging.service';
import { VideoAutoTaggingService } from './video-auto-tagging.service';

/**
 * `video_auto_tagging` — AI tags + description for videos (epic #452, #455).
 *
 * A SEPARATE job type from `auto_tagging`, not a branch inside it. That is
 * required rather than stylistic, for three concrete reasons:
 *
 *   1. The 20-minute ENRICHMENT_VIDEO_JOB_TIMEOUT_MS budget is applied by job
 *      TYPE (VIDEO_JOB_TYPES in enrichment-job.worker.ts). Branching inside
 *      `auto_tagging` would hand every photo-tagging job a 20-minute budget.
 *   2. Node capability requirements are per type — ['sharp'] for photos vs.
 *      ['sharp','ffmpeg','ffprobe'] here. A node without ffmpeg must not
 *      advertise the video type.
 *   3. /admin/settings/jobs filtering, job-type-labels, and per-type queue
 *      insights all key on type.
 *
 * Everything DOWNSTREAM is shared: the tag_labels vocabulary,
 * media_tag_status, media_items.description, the MediaTagSource.ai write
 * semantics, and the media_item_embedding upsert.
 */
@Injectable()
export class VideoAutoTaggingHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'video_auto_tagging';

  /**
   * Node-eligibility (distributed workers, issue #460): the payload a node
   * submits via POST /api/nodes/:id/jobs/:jobId/result.
   */
  readonly nodeResultSchema = videoAutoTaggingResultSchema;

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly videoAutoTaggingService: VideoAutoTaggingService,
    private readonly autoTaggingService: AutoTaggingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.videoAutoTaggingService.processMediaItem(job);
  }

  /**
   * Persist a node-computed result.
   *
   * Parsing stays SERVER-side (it needs the DB-loaded TagLabel vocabulary), so
   * this delegates to the very same persist half the photo path uses — one
   * implementation of vocabulary validation for both job types.
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = videoAutoTaggingResultSchema.parse(result);
    await this.videoAutoTaggingService.persistNodeTranscript(job, parsed);
    await this.autoTaggingService.persistAutoTagging(job, { rawText: parsed.rawText });
  }
}
