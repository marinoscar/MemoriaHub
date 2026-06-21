import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { SimilarityDetectionService } from './similarity-detection.service';

@Injectable()
export class SimilarityDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'similarity_detection';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly similarityDetectionService: SimilarityDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.similarityDetectionService.processMediaItem(job);
  }
}
