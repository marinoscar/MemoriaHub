import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The review-runs slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it reads
// and writes; a delegate is structural and loose on purpose (the rows are the domain's `memoriahub-db`
// schema, which the host types for its own callers).
// =============================================================================

/**
 * The model delegates the review-runs slice uses.
 *
 * @stability experimental
 */
export interface ReviewRunsModels {
  /** The runs. */
  reviewRun: MediaDelegate;
  /** The run items (the exclusive arc of subject columns). */
  reviewRunItem: MediaDelegate;
  /** The audit trail. */
  auditEvent: MediaDelegate;
}

/**
 * The database port narrowed to the review-runs slice's delegates.
 *
 * @stability experimental
 */
export type ReviewRunsDb = MemoriahubPrismaClientLike & ReviewRunsModels;
