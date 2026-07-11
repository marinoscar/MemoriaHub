import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { duplicateDetectionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { DuplicateDetectionService } from './duplicate-detection.service';

@Injectable()
export class DuplicateDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'duplicate_detection';

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @memoriahub/enrichment-compute/dto.
   */
  readonly nodeResultSchema = duplicateDetectionResultSchema;

  private readonly logger = new Logger(DuplicateDetectionHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly duplicateDetectionService: DuplicateDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      this.logger.warn(`duplicate_detection job ${job.id} has no mediaItemId; skipping`);
      return;
    }
    await this.duplicateDetectionService.processMediaItem(job.mediaItemId);
  }

  /**
   * Persist a node-computed duplicate_detection result (already validated
   * against nodeResultSchema by the ingestion endpoint; re-parsed here for
   * type narrowing). The node contract carries {model, embedding, dHash} but
   * no sharpnessScore — sharpnessScore: null makes persistDuplicate skip the
   * sharpness column write, exactly what the server compute path does when
   * sharpness is unavailable.
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = duplicateDetectionResultSchema.parse(result);
    await this.duplicateDetectionService.persistDuplicate(job, {
      model: parsed.model,
      embedding: parsed.embedding,
      dHash: parsed.dHash,
      sharpnessScore: null,
    });
  }
}
