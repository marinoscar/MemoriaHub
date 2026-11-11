import type { MemoriahubPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The media slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client (a bare host has its own, or none).
// It narrows `MEMORIAHUB_PRISMA` with the delegates it uses. A delegate here is
// structural and loose on purpose: the rows are the domain's `memoriahub-db`
// schema, which the host's generated client types for its own callers; the slice
// reads only the columns it names in a `select`.
// =============================================================================

/**
 * One model delegate, as the slice calls it.
 *
 * @stability experimental
 */
export interface MediaDelegate {
  /** Reads many rows. */
  findMany(args?: any): Promise<any[]>;
  /** Reads the first matching row. */
  findFirst(args?: any): Promise<any | null>;
  /** Reads a row by a unique key. */
  findUnique(args: any): Promise<any | null>;
  /** Reads a row by a unique key or throws. */
  findUniqueOrThrow(args: any): Promise<any>;
  /** Creates a row. */
  create(args: any): Promise<any>;
  /** Creates many rows. */
  createMany(args: any): Promise<{ count: number }>;
  /** Updates a row. */
  update(args: any): Promise<any>;
  /** Updates many rows. */
  updateMany(args: any): Promise<{ count: number }>;
  /** Creates or updates a row. */
  upsert(args: any): Promise<any>;
  /** Deletes a row. */
  delete(args: any): Promise<any>;
  /** Deletes many rows. */
  deleteMany(args?: any): Promise<{ count: number }>;
  /** Counts rows. */
  count(args?: any): Promise<number>;
  /** Aggregates rows. */
  aggregate(args: any): Promise<any>;
  /** Groups and counts rows. */
  groupBy(args: any): Promise<any[]>;
}

/**
 * The models of the media slice. A transaction client has the same shape.
 *
 * @stability experimental
 */
export interface MediaModels {
  /** `media_items`. */
  mediaItem: MediaDelegate;
  /** `storage_objects`. */
  storageObject: MediaDelegate;
  /** `media_sync_devices`. */
  mediaSyncDevice: MediaDelegate;
  /** `media_sync_runs`. */
  mediaSyncRun: MediaDelegate;
  /** `media_sync_diagnostic_reports`. */
  mediaSyncDiagnosticReport: MediaDelegate;
  /** `android_app_releases`. */
  androidAppRelease: MediaDelegate;
  /** `personal_access_tokens` (a platform table the device row links to). */
  personalAccessToken: MediaDelegate;
  /** `audit_events`. */
  auditEvent: MediaDelegate;
  /** `users`. */
  user: MediaDelegate;
  /** `trash_empty_runs`. */
  trashEmptyRun: MediaDelegate;
  /** `trash_empty_run_items`. */
  trashEmptyRunItem: MediaDelegate;
  /** `media_metadata_status`. */
  mediaMetadataStatus: MediaDelegate;
  /** `albums`. */
  album: MediaDelegate;
  /** `album_items`. */
  albumItem: MediaDelegate;
  /** `tags`. */
  tag: MediaDelegate;
  /** `media_tags`. */
  mediaTag: MediaDelegate;
  /** `burst_groups` (the review-queue count). */
  burstGroup: MediaDelegate;
  /** `duplicate_groups` (the review-queue count). */
  duplicateGroup: MediaDelegate;
  /** `location_suggestions` (the review-queue count). */
  locationSuggestion: MediaDelegate;
  /** `media_enhancements` (the review-queue count). */
  mediaEnhancement: MediaDelegate;
  /** `system_settings` (the burst minimum group size). */
  systemSettings: MediaDelegate;
  /** `location_groups` (the tiered browsing cover override). */
  locationGroup: MediaDelegate;
}

/**
 * The client a media provider holds: the port plus the media delegates.
 *
 * @stability experimental
 */
export type MediaDb = MemoriahubPrismaClientLike & MediaModels;

/**
 * A transaction client of {@link MediaDb}.
 *
 * @stability experimental
 */
export type MediaTx = MediaModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;
