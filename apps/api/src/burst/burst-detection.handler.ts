import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { BurstDetectionService } from './burst-detection.service';

@Injectable()
export class BurstDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'burst_detection';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly burstDetectionService: BurstDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.burstDetectionService.processMediaItem(job);
  }
}
