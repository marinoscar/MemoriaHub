import type { MediaDelegate } from '../../media/index.js';
import type { MemoriahubPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The memories slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// reads and writes; a delegate is structural and loose on purpose (the rows are the domain's
// `memoriahub-db` schema, which the host types for its own callers). A transaction client has the
// same delegates.
// =============================================================================

/**
 * A model delegate with the `groupBy` the job queries use.
 *
 * @stability experimental
 */
export interface MemoriesDelegate extends MediaDelegate {
  /** Groups rows by columns. */
  groupBy(args: any): Promise<any[]>;
}

/**
 * The models of the memories slice.
 *
 * @stability experimental
 */
export interface MemoriesModels {
  /** `memories`. */
  memory: MemoriesDelegate;
  /** `memory_items`. */
  memoryItem: MediaDelegate;
  /** `memory_user_state`. */
  memoryUserState: MediaDelegate;
  /** `media_items`. */
  mediaItem: MediaDelegate;
  /** `media_tags`. */
  mediaTag: MediaDelegate;
  /** `storage_objects`. */
  storageObject: MediaDelegate;
  /** `people`. */
  person: MediaDelegate;
  /** `faces`. */
  face: MediaDelegate;
  /** `burst_groups`. */
  burstGroup: MediaDelegate;
  /** `duplicate_groups`. */
  duplicateGroup: MediaDelegate;
  /** `jobs`: only read, for the digest and generation watermarks. */
  job: MemoriesDelegate;
}

/**
 * The database client of the memories slice.
 *
 * @stability experimental
 */
export type MemoriesDb = MemoriahubPrismaClientLike & MemoriesModels;

/**
 * A transaction client of {@link MemoriesDb}.
 *
 * @stability experimental
 */
export type MemoriesTx = MemoriesModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;

/**
 * A Prisma unique-constraint violation (`P2002`), seen structurally.
 *
 * @param error - the thrown value.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
