/**
 * A photo/video whose thumbnailUrl is still null past this many milliseconds
 * since upload is treated as stuck rather than "still processing" — the
 * backend's automatic recovery (StorageProcessingRecoveryTask, default 10
 * minute threshold) should have already resolved it one way or the other by
 * then. 15 minutes gives comfortable margin above that server-side window.
 */
export const THUMBNAIL_STUCK_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Returns true once `createdAt` is older than `thresholdMs`. Used by gallery
 * tiles to fall back from an indefinite "Processing…" spinner to a broken-
 * image state once a thumbnail has plausibly failed to generate.
 */
export function isThumbnailStuck(
  createdAt: string,
  thresholdMs: number = THUMBNAIL_STUCK_THRESHOLD_MS,
): boolean {
  const createdAtMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return Date.now() - createdAtMs > thresholdMs;
}
