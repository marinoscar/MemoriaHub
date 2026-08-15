/**
 * Thumbnail storage-key convention (issue #434).
 *
 * Thumbnails used to live at a CONTENT-INDEPENDENT key, `thumbnails/<objectId>.jpg`,
 * derived solely from the source StorageObject id. That key is stable across any
 * number of regenerations, which is fine while thumbnail bytes never change —
 * and it is exactly what makes `Cache-Control: public, max-age=31536000, immutable`
 * (thumbnail-render.util.ts) plus MediaThumbnailService's 24h signed-URL reuse
 * safe for the overwhelmingly common case.
 *
 * The app has two DESTRUCTIVE-OVERWRITE paths that violate that premise by
 * rewriting an original's bytes in place — the AI Picture Enhancer's
 * `decision: 'replace'` and the orientation editor. Both regenerate correct new
 * thumbnail bytes, but under the old scheme those bytes landed at a byte-identical
 * URL that the API cache, the browser and any CDN had all been told was immutable,
 * so every grid surface kept rendering the pre-edit image while the lightbox (which
 * re-signs a fresh `downloadUrl`) showed the new one.
 *
 * The key is now VERSIONED: `thumbnails/<objectId>-<version>.jpg`. Server-rendered
 * thumbnails derive `version` from a hash of the thumbnail bytes themselves, so the
 * scheme is CONTENT-ADDRESSED:
 *
 *   - unchanged source bytes re-render to identical thumbnail bytes → identical key
 *     → the upsert stays idempotent, no key churn, no needless cache invalidation;
 *   - changed source bytes → different key → a different URL that no cache has ever
 *     seen, so `immutable` becomes a true statement rather than a bug.
 *
 * The node path (`POST /api/nodes/:id/jobs/:jobId/upload-url`) must choose the key
 * BEFORE any bytes exist, so it uses a random version instead. Correctness only
 * needs the key to change when the bytes might have; content-addressing is the
 * stronger property that additionally avoids churn where it is available.
 *
 * Superseded keys are cleaned up by ThumbnailPruneService, always AFTER the
 * MediaItem's `metadata.thumbnailStorageKey` has been repointed at the new key.
 */
import { createHash, randomBytes } from 'crypto';

/** Prefix every derived thumbnail object lives under. */
export const THUMBNAIL_KEY_PREFIX = 'thumbnails/';

/**
 * Prefix shared by EVERY thumbnail key that has ever belonged to one source
 * object — the legacy unversioned `thumbnails/<id>.jpg` included. Used to find
 * superseded thumbnails for pruning. Object ids are UUIDs, so this prefix can
 * never match another object's thumbnails.
 */
export function thumbnailKeyPrefixFor(sourceObjectId: string): string {
  return `${THUMBNAIL_KEY_PREFIX}${sourceObjectId}`;
}

/** Build the versioned thumbnail key for a source object. */
export function buildThumbnailKey(sourceObjectId: string, version: string): string {
  return `${thumbnailKeyPrefixFor(sourceObjectId)}-${version}.jpg`;
}

/**
 * Content-addressed version token: a truncated sha256 of the thumbnail bytes.
 * 16 hex chars (64 bits) is far more than enough to distinguish the handful of
 * renditions one object ever produces, and keeps the key readable.
 */
export function thumbnailVersionFromBytes(thumbBuffer: Buffer): string {
  return createHash('sha256').update(thumbBuffer).digest('hex').slice(0, 16);
}

/**
 * Random version token, for the one caller that must name a key before it has
 * the bytes to hash (the node presigned-upload path).
 */
export function randomThumbnailVersion(): string {
  return randomBytes(8).toString('hex');
}
