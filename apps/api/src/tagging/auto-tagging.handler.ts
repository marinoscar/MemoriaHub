import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { AutoTaggingService } from './auto-tagging.service';

@Injectable()
export class AutoTaggingHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'auto_tagging';

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
}
