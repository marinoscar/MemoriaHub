import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { SocialDetectionService } from './social-detection.service';

@Injectable()
export class SocialDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'social_media_detection';

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly socialDetectionService: SocialDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.socialDetectionService.processMediaItem(job);
  }
}
