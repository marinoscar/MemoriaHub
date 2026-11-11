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

// =============================================================================
// What the gallery service needs of the host (RETRO-J5, #613)
// =============================================================================
//
// The gallery service (`MediaService`) is host-neutral: it reaches the geocoders, the enrichment
// fan-out helpers and the outbound webhooks through these four hooks, plus the access, object-store,
// metrics and prisma ports. Each token's description string is permanent.
// =============================================================================

/**
 * Injection token of {@link MediaGeoLocationProvider}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_GEO_LOCATION_PROVIDER = Symbol.for('@marinoscar/memoriahub/MEDIA_GEO_LOCATION_PROVIDER');

/**
 * Reverse-geocodes a coordinate pair through the active provider (offline dataset, Nominatim or
 * Google): the answer the location write paths (a manual location, a bulk location edit, the client
 * fallback of an upload) turn into the geo columns. The host binds its delegating geo provider.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaGeoLocationProvider {
  /**
   * Reverse-geocodes a coordinate pair.
   *
   * @param lat - latitude in decimal degrees.
   * @param lng - longitude in decimal degrees.
   * @returns the tiers, or null when the lookup found nothing.
   */
  reverseGeocode(lat: number, lng: number): Promise<MediaGeocodeResultLike | null>;
}

/** The tiers of a reverse-geocoding answer, as the gallery reads them. @stability experimental */
export interface MediaGeocodeResultLike {
  country?: string;
  countryCode?: string;
  admin1?: string;
  admin2?: string;
  locality?: string;
  placeName?: string;
}

/**
 * Injection token of {@link MediaForwardGeocoder}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_FORWARD_GEOCODER = Symbol.for('@marinoscar/memoriahub/MEDIA_FORWARD_GEOCODER');

/**
 * Forward geocoding (place search by typed text) for `GET /api/media/geo/search`. The host binds its
 * forward geocoder, which answers `503` when the deployment disabled place search.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaForwardGeocoder {
  /**
   * Searches places.
   *
   * @param q - the typed query.
   * @param limit - the most results.
   */
  searchPlaces(q: string, limit: number): Promise<unknown[]>;
}

/**
 * Injection token of {@link MediaEnrichment}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_ENRICHMENT = Symbol.for('@marinoscar/memoriahub/MEDIA_ENRICHMENT');

/**
 * The enrichment fan-out helpers the gallery calls: the upload-time jobs of a new item and the
 * per-item reruns of the bulk actions. The host owns them (the video post-detection fan-out, the
 * legacy queue facade and the per-type routing live there).
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaEnrichment {
  /**
   * Enqueues every upload-time enrichment job of a freshly registered item (never rethrows).
   *
   * @param item - the registered item.
   */
  enqueueUploadEnrichment(item: { id: string; type: string; circleId: string; deletedAt: Date | null }): Promise<void>;

  /**
   * Enqueues a tagging rerun for one item (photo or video routing).
   *
   * @param item - the item; `type` is read from the row when absent.
   */
  enqueueTagRerun(item: { id: string; circleId: string; type?: string }): Promise<void>;

  /**
   * Enqueues a face detection rerun for one item (photo or video routing).
   *
   * @param item - the item.
   */
  enqueueFaceRerun(item: { id: string; type: string; circleId: string }): Promise<void>;

  /**
   * Enqueues the asynchronous thumbnail regeneration job of one item.
   *
   * @param item - the item.
   */
  enqueueThumbnailRerun(item: { id: string; circleId: string }): Promise<void>;
}

/**
 * Injection token of {@link MediaWebhookEvents}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_WEBHOOK_EVENTS = Symbol.for('@marinoscar/memoriahub/MEDIA_WEBHOOK_EVENTS');

/**
 * The outbound webhook events of the media lifecycle (`media.item.created`, `media.upload.completed`,
 * `media.item.trashed`, `media.item.deleted`). Every call is synchronous, does no I/O and never
 * throws: the host batches the entries and fans them out in the queue. Optional: unbound is a no-op.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaWebhookEvents {
  /**
   * A media item was registered (the non-deduplicated path of a registration).
   *
   * @param item - the new item.
   */
  mediaCreated(item: { id: string; circleId: string; type: 'photo' | 'video'; capturedAt: Date | null; addedById: string | null }): void;

  /**
   * Items of one library moved to Trash.
   *
   * @param circleId - the library.
   * @param mediaItemIds - the items.
   */
  mediaTrashed(circleId: string, mediaItemIds: readonly string[]): void;

  /**
   * Items were permanently deleted.
   *
   * @param rows - the deleted rows.
   */
  mediaDeleted(rows: readonly { id: string; circleId: string }[]): void;
}
