import type { MediaModels, MediaTx } from '../data/media-db.js';

// =============================================================================
// What the thumbnail jobs need of the host's post-upload processing (RETRO-J5, #613)
// =============================================================================
//
// The post-upload pipeline (the processors, the content-addressed thumbnail pruning, the cross-
// organization database client) belongs to the host, so the media slice reaches it through these
// three hooks. Each token's description string is permanent.
// =============================================================================

/**
 * Injection token of {@link MediaObjectReprocessor}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_OBJECT_REPROCESSOR = Symbol.for('@marinoscar/memoriahub/MEDIA_OBJECT_REPROCESSOR');

/**
 * Re-runs the post-upload processors for ONE stored object, now: resets it to `processing` with its
 * retry bookkeeping cleared, runs every processor, writes `ready` or `failed` and announces the
 * object as processed (which makes the host sync the media item). The thumbnail jobs call it from
 * inside a job, so inline execution of one object is bounded.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaObjectReprocessor {
  /**
   * Re-runs the processors for the object.
   *
   * @param object - the `storage_objects` row (with its organization).
   * @returns the processing outcome.
   */
  reprocessNow(object: any): Promise<unknown>;
}

/**
 * Injection token of {@link MediaThumbnailPruner}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_THUMBNAIL_PRUNER = Symbol.for('@marinoscar/memoriahub/MEDIA_THUMBNAIL_PRUNER');

/**
 * Deletes the thumbnails a source object no longer points at (bytes first, then the row; best-effort,
 * never throws). A destructive overwrite must reprocess, THEN await the media item sync, THEN prune
 * (issue #434): pruning first would delete bytes a concurrent gallery request could still be signing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaThumbnailPruner {
  /**
   * Prunes the superseded thumbnails of a source object.
   *
   * @param sourceObjectId - the source `storage_objects` id.
   * @returns how many were pruned.
   */
  pruneSupersededThumbnails(sourceObjectId: string): Promise<number>;
}

/**
 * Injection token of {@link MediaSystemAccess}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_SYSTEM_ACCESS = Symbol.for('@marinoscar/memoriahub/MEDIA_SYSTEM_ACCESS');

/**
 * The database client that crosses organizations, for the global housekeeping sweep that has none to
 * scope to (the thumbnail repair scan and its attempt counters). The host binds it to its system
 * client under the reason it registered for media housekeeping.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaSystemAccess {
  /**
   * Runs `fn` in one transaction on the cross-organization client.
   *
   * @param fn - the work.
   */
  runAsSystem<R>(fn: (tx: MediaTx) => Promise<R>): Promise<R>;

  /** The cross-organization client for single statements. */
  asSystem(): MediaModels;
}
