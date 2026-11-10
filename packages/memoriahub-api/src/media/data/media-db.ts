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
}

/**
 * The models of the media slice. A transaction client has the same shape.
 *
 * @stability experimental
 */
export interface MediaModels {
  /** `media_items`. */
  mediaItem: MediaDelegate;
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
