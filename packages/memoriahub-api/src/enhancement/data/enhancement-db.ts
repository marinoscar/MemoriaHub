import type { MediaDelegate } from '../../media/index.js';
import type { MemoriahubPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The enhancement slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// uses; a delegate is structural and loose (the rows are the domain's `memoriahub-db` schema, which
// the host's generated client types for its own callers).
// =============================================================================

/**
 * The model delegates the enhancement slice uses.
 *
 * @stability experimental
 */
export interface EnhancementModels {
  /** The enhancement rows (one per requested render). */
  mediaEnhancement: MediaDelegate;
  /** The bulk-enhance batches. */
  mediaEnhancementBatch: MediaDelegate;
  /** The media items (source photos, and the new item of a keep-both). */
  mediaItem: MediaDelegate;
  /** The stored originals and the staged copies' source objects. */
  storageObject: MediaDelegate;
  /** The circle tags (`AI Enhanced`). */
  tag: MediaDelegate;
  /** The item-to-tag join rows. */
  mediaTag: MediaDelegate;
  /** The face detection status (reset after a replace). */
  mediaFaceStatus: MediaDelegate;
  /** The queue's rows (a cancelled batch deletes its still-pending jobs). */
  job: MediaDelegate;
  /** The audit trail. */
  auditEvent: MediaDelegate;
}

/**
 * The database port narrowed to the enhancement slice's delegates.
 *
 * @stability experimental
 */
export type EnhancementDb = MemoriahubPrismaClientLike & EnhancementModels;

/**
 * A transaction client narrowed to the same delegates.
 *
 * @stability experimental
 */
export type EnhancementTx = EnhancementModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;
