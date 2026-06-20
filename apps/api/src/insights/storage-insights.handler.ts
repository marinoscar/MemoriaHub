import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { InsightsService } from './insights.service';

@Injectable()
export class StorageInsightsHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'storage_insights';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly insights: InsightsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    await this.insights.runComputation();
  }
}
