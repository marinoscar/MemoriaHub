import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MediaMetadataSyncService } from '@marinoscar/memoriahub-api/media';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../media-processing/events/object-processed.event';

/**
 * MediaMetadataSyncListener
 *
 * Handles OBJECT_PROCESSED_EVENT (emitted by the post-upload processing pipeline after all
 * processors have run) and delegates to the packaged `MediaMetadataSyncService`, which copies
 * the processor metadata into the typed columns of the linked media item. The event belongs to
 * the host's pipeline, so the listener stays here; the sync logic is in
 * `@marinoscar/memoriahub-api/media`.
 *
 * Never rethrows; a sync failure must not crash the event loop.
 */
@Injectable()
export class MediaMetadataSyncListener {
  private readonly logger = new Logger(MediaMetadataSyncListener.name);

  constructor(private readonly sync: MediaMetadataSyncService) {}

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handleObjectProcessed(event: ObjectProcessedEvent): Promise<void> {
    const { storageObjectId } = event;

    try {
      await this.sync.syncFromStorageObject(storageObjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `MediaMetadataSyncService failed for StorageObject ${storageObjectId}: ${message}`,
      );
      // Do NOT rethrow — a sync failure should not crash the event loop
    }
  }
}
