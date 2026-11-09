// =============================================================================
// The media type of an object being processed, for app.media.processing.duration
// (RETRO-T3, #628)
// =============================================================================
//
// The platform's `storage.object.process` job carries only the object id, and the
// `job.settled` listener that records the duration must do no I/O
// (`on-event-no-io`). So the first processor (`content-hash`, which runs on every
// object) remembers the object's mime type here, in process memory, and the
// listener takes it back when the job settles. The job is server-only and settles
// in the process that ran it. Bounded: the oldest entry goes past 5 000.
// =============================================================================

const MAX_ENTRIES = 5_000;
const mimeById = new Map<string, string>();

/** Remembers `mimeType` for the object being processed. */
export function rememberProcessingMime(objectId: string, mimeType: string): void {
  mimeById.delete(objectId);
  mimeById.set(objectId, mimeType);
  if (mimeById.size > MAX_ENTRIES) {
    const oldest = mimeById.keys().next().value;
    if (oldest !== undefined) mimeById.delete(oldest);
  }
}

/** The remembered mime type of `objectId` (forgotten as it is read), or undefined. */
export function takeProcessingMime(objectId: string): string | undefined {
  const mime = mimeById.get(objectId);
  mimeById.delete(objectId);
  return mime;
}
