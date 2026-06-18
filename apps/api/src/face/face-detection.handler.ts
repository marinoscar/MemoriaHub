import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { FaceDetectionService } from './face-detection.service';

@Injectable()
export class FaceDetectionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'face_detection';

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
}
