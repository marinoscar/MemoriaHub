import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The location slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// reads and writes; a delegate is structural and loose on purpose (the rows are the domain's
// `memoriahub-db` schema, which the host types for its own callers).
// =============================================================================

/**
 * A model delegate with `groupBy`.
 *
 * @stability experimental
 */
export interface LocationDelegate extends MediaDelegate {
  /** Groups rows. */
  groupBy(args: any): Promise<any[]>;
}

/**
 * The model delegates the location slice uses.
 *
 * @stability experimental
 */
export interface LocationModels {
  /** The admin-curated canonical places. */
  locationGroup: LocationDelegate;
  /** The raw geocoder spellings a group claims. */
  locationGroupAlias: LocationDelegate;
  /** The media items (raw and canonical geo columns, coordinates). */
  mediaItem: LocationDelegate;
  /** The location suggestions of the review queue. */
  locationSuggestion: LocationDelegate;
  /** The audit log. */
  auditEvent: LocationDelegate;
  /** The per-item geocoding status (one row per media item). */
  mediaGeocodeStatus: LocationDelegate;
  /** The platform job rows (the state of a queued job). */
  job: MediaDelegate;
}

/**
 * The database port narrowed to the location slice's delegates.
 *
 * @stability experimental
 */
export type LocationDb = MemoriahubPrismaClientLike & LocationModels;

/**
 * A transaction client of {@link LocationDb}.
 *
 * @stability experimental
 */
export type LocationTx = LocationModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;
