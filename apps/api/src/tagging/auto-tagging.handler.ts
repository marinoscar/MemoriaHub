import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { autoTaggingResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { AutoTaggingService } from './auto-tagging.service';

@Injectable()
export class AutoTaggingHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'auto_tagging';

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @memoriahub/enrichment-compute/dto.
   */
  readonly nodeResultSchema = autoTaggingResultSchema;

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly autoTaggingService: AutoTaggingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.autoTaggingService.processMediaItem(job);
  }

  /**
   * Persist a node-computed auto_tagging result (already validated against
   * nodeResultSchema by the ingestion endpoint; re-parsed here for type
   * narrowing, mirroring DuplicateDetectionHandler's precedent).
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = autoTaggingResultSchema.parse(result);
    await this.autoTaggingService.persistAutoTagging(job, parsed);
  }
}
