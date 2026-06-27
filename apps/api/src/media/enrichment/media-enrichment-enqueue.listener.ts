import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../storage/processing/events/object-processed.event';
import { MediaEnrichmentService } from './media-enrichment.service';

/**
 * MediaEnrichmentEnqueueListener
 *
 * Backstop listener: handles OBJECT_PROCESSED_EVENT (emitted by the
 * storage-processing pipeline after all processors have run) and delegates
 * to MediaEnrichmentService.enqueueForStorageObject.
 *
 * This covers re-processing and any future path that emits the event without
 * going through createMedia. The primary upload-time trigger is the direct
 * awaited call in createMedia — this listener is the secondary fallback.
 *
 * Never rethrows; errors are logged only.
 */
@Injectable()
export class MediaEnrichmentEnqueueListener {
  private readonly logger = new Logger(MediaEnrichmentEnqueueListener.name);

  constructor(private readonly svc: MediaEnrichmentService) {}

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handle(event: ObjectProcessedEvent): Promise<void> {
    try {
      await this.svc.enqueueForStorageObject(event.storageObjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `MediaEnrichmentEnqueueListener failed for StorageObject ${event.storageObjectId}: ${message}`,
      );
      // Never rethrow — listeners must not crash the event bus.
    }
  }
}
