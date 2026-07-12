// =============================================================================
// VideoFaceDetectionHandler  (type = 'video_face_detection')
// =============================================================================
//
// Thin enrichment-queue entry point. All pipeline logic (compute + persist)
// lives in VideoFaceDetectionService — this handler only wires the queue's
// process()/persistNodeResult() contract to that service, mirroring
// FaceDetectionHandler's relationship to FaceDetectionService exactly.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { videoFaceDetectionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { VideoFaceDetectionService } from './video-face-detection.service';

@Injectable()
export class VideoFaceDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'video_face_detection';

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @memoriahub/enrichment-compute/dto. A node always computes
   * with the keyless Human provider (never Rekognition's delegated
   * recognition, which this schema does not carry an externalFaceId for —
   * see VideoFaceDetectionService's module docstring / this PR's handoff
   * notes for the resulting, pre-existing-but-untested gap on the
   * in-process Rekognition-delegated video path).
   */
  readonly nodeResultSchema = videoFaceDetectionResultSchema;

  private readonly logger = new Logger(VideoFaceDetectionHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly videoFaceDetectionService: VideoFaceDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.videoFaceDetectionService.processMediaItem(job);
  }

  /**
   * Persist a node-computed video_face_detection result (already validated
   * against nodeResultSchema by the ingestion endpoint; re-parsed here for
   * type narrowing, mirroring FaceDetectionHandler/DuplicateDetectionHandler's
   * precedent).
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = videoFaceDetectionResultSchema.parse(result);
    this.logger.debug(
      `VideoFaceJob ${job.id}: persisting node-computed result (${parsed.clusters.length} cluster(s))`,
    );
    await this.videoFaceDetectionService.persistVideoFaces(job, parsed);
  }
}
