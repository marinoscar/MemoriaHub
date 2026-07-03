import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { DuplicateDetectionService } from './duplicate-detection.service';

@Injectable()
export class DuplicateDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'duplicate_detection';
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
}
