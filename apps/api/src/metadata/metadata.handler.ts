import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { MetadataExtractionService } from './metadata.service';

@Injectable()
export class MetadataExtractionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'metadata_extraction';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly metadataExtractionService: MetadataExtractionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.metadataExtractionService.processMediaItem(job);
  }
}
