import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { faceDetectionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { FaceDetectionService } from './face-detection.service';

@Injectable()
export class FaceDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'face_detection';

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @memoriahub/enrichment-compute/dto. A node always computes
   * with the keyless Human provider (1024-d); see
   * FaceDetectionService.warnOnProviderMismatch for the cross-provider
   * embedding-space caveat this implies when the server's active provider
   * differs.
   */
  readonly nodeResultSchema = faceDetectionResultSchema;

  private readonly logger = new Logger(FaceDetectionHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly faceDetectionService: FaceDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.faceDetectionService.processMediaItem(job);
  }

  /**
   * Persist a node-computed face_detection result (already validated against
   * nodeResultSchema by the ingestion endpoint; re-parsed here for type
   * narrowing, mirroring DuplicateDetectionHandler's precedent).
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = faceDetectionResultSchema.parse(result);
    this.logger.debug(`FaceJob ${job.id}: persisting node-computed result (${parsed.faces.length} face(s))`);
    await this.faceDetectionService.persistFaces(job, parsed);
  }
}
