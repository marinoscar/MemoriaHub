import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The burst slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// reads and writes; a delegate is structural and loose on purpose (the rows are the domain's
// `memoriahub-db` schema, which the host types for its own callers).
// =============================================================================

/**
 * The model delegates the burst slice uses.
 *
 * @stability experimental
 */
export interface BurstModels {
  /** The media items (burst membership, perceptual hash, scores). */
  mediaItem: MediaDelegate;
  /** The burst review groups. */
  burstGroup: MediaDelegate;
  /** The stored originals (read to download the bytes of a legacy photo). */
  storageObject: MediaDelegate;
  /** The detected faces (read to score the best shot). */
  face: MediaDelegate;
  /** The queued jobs (read to skip photos a burst job already succeeded for). */
  job: MediaDelegate;
  /** The audit trail. */
  auditEvent: MediaDelegate;
}

/**
 * The database port narrowed to the burst slice's delegates.
 *
 * @stability experimental
 */
export type BurstDb = MemoriahubPrismaClientLike & BurstModels;
