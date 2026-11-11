import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The dedup slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// reads and writes; a delegate is structural and loose on purpose (the rows are the domain's
// `memoriahub-db` schema, which the host types for its own callers). The pgvector tables
// (`media_visual_embedding`) are reached through raw SQL only: Prisma cannot type a `vector` column.
// =============================================================================

/**
 * A model delegate with `groupBy`.
 *
 * @stability experimental
 */
export interface DedupDelegate extends MediaDelegate {
  /** Groups rows. */
  groupBy(args: any): Promise<any[]>;
}

/**
 * The model delegates the dedup slice uses.
 *
 * @stability experimental
 */
export interface DedupModels {
  /** The media items (perceptual hash, duplicate group membership). */
  mediaItem: DedupDelegate;
  /** The stored originals (read to download the bytes). */
  storageObject: MediaDelegate;
  /** The burst groups (read so a pending burst wins over a duplicate). */
  burstGroup: DedupDelegate;
  /** The duplicate review groups. */
  duplicateGroup: DedupDelegate;
  /** The queued jobs (read for the status of a rerun job). */
  job: MediaDelegate;
  /** The audit trail. */
  auditEvent: MediaDelegate;
}

/**
 * The database port narrowed to the dedup slice's delegates.
 *
 * @stability experimental
 */
export type DedupDb = MemoriahubPrismaClientLike & DedupModels;

/**
 * A transaction client of {@link DedupDb}.
 *
 * @stability experimental
 */
export type DedupTx = DedupModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;
