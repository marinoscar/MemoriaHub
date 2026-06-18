import { Injectable } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { FaceDetectionService } from './face-detection.service';

@Injectable()
export class FaceDetectionHandler implements EnrichmentHandler {
  readonly type = 'face_detection';

  constructor(private readonly faceDetectionService: FaceDetectionService) {}

  async process(job: EnrichmentJob): Promise<void> {
    await this.faceDetectionService.processMediaItem(job);
  }
}
