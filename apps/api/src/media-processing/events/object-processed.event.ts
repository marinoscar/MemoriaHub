/**
 * Emitted by ObjectProcessingService after all processors have run for an
 * uploaded object (regardless of whether any individual processor failed).
 *
 * Consumers (e.g. MediaMetadataSyncService) use this event to react to
 * completed processing without creating a circular dependency back into the
 * storage module.
 */
export class ObjectProcessedEvent {
  constructor(
    public readonly storageObjectId: string,
  ) {}
}

export const OBJECT_PROCESSED_EVENT = 'storage.object.processed';
