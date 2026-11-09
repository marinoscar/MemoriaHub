import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { JOB_SETTLED_EVENT, type JobSettledEvent } from '@marinoscar/platform-api/jobs';
import {
  ObjectProcessingService,
  STORAGE_OBJECT_PROCESS_TYPE,
  type ObjectProcessingOutcome,
  type StorageObject,
} from '@marinoscar/platform-api/storage';

import { OBJECT_PROCESSED_EVENT, ObjectProcessedEvent } from './events/object-processed.event';

// =============================================================================
// MediaObjectProcessingService: the processing pipeline's completion hook (RETRO-D1, #563)
// =============================================================================
//
// Since RETRO-D1 an upload is processed by the platform's server-only
// `storage.object.process` job (the processors are MemoriaHub's seven, registered
// on `ObjectProcessorRegistry` by `MediaProcessorsRegistrar`). MemoriaHub's
// consumers of a finished run (`MediaMetadataSyncService`, the enrichment
// backstop) listen to the app event `storage.object.processed`
// (`OBJECT_PROCESSED_EVENT`), which the platform does not emit. Two paths emit it:
//
//   1. A queued run: `onJobSettled` re-emits it when a `storage.object.process`
//      job settles (success, or a give-up the platform has just marked `failed`),
//      exactly when the old in-process pipeline emitted it after its last
//      processor. A pure re-emit: no I/O in the listener.
//   2. An inline re-run (`runNow`): the destructive edits (orientation, the AI
//      enhancer's replace) and the recovery service reprocess an object in the
//      request or job that changed it, then emit the event themselves, as before.
// =============================================================================

@Injectable()
export class MediaObjectProcessingService {
  private readonly logger = new Logger(MediaObjectProcessingService.name);

  constructor(
    private readonly processing: ObjectProcessingService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Runs every registered processor against `object` now, in this call, writes
   * the outcome to its row (`ready` or `failed`) and emits `OBJECT_PROCESSED_EVENT`.
   */
  async runNow(object: StorageObject): Promise<ObjectProcessingOutcome> {
    const outcome = await this.processing.run(object);
    this.events.emit(OBJECT_PROCESSED_EVENT, new ObjectProcessedEvent(object.id));
    return outcome;
  }

  /** A queued processing run settled: tell MemoriaHub's consumers. Never throws. */
  @OnEvent(JOB_SETTLED_EVENT)
  onJobSettled(event: JobSettledEvent): void {
    if (event.type !== STORAGE_OBJECT_PROCESS_TYPE || !event.subjectId) return;
    try {
      this.events.emit(OBJECT_PROCESSED_EVENT, new ObjectProcessedEvent(event.subjectId));
    } catch (error) {
      this.logger.error(
        `Could not emit ${OBJECT_PROCESSED_EVENT} for object ${event.subjectId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
