import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The insights slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// reads and writes; a delegate is structural and loose on purpose (the rows are the domain's
// `memoriahub-db` schema, which the host types for its own callers).
// =============================================================================

/**
 * The model delegates the insights slice uses.
 *
 * @stability experimental
 */
export interface InsightsModels {
  /** The detected faces (counted). */
  face: MediaDelegate;
  /** The per-item tagging status (counted). */
  mediaTagStatus: MediaDelegate;
  /** The snapshot rows. */
  insightsSnapshot: MediaDelegate;
  /** The platform job rows (read for the refresh state of the global job). */
  job: MediaDelegate;
}

/**
 * The database port narrowed to the insights slice's delegates.
 *
 * @stability experimental
 */
export type InsightsDb = MemoriahubPrismaClientLike & InsightsModels;
