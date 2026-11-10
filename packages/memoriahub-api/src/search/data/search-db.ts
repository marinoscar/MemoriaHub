import type { MediaDelegate } from '../../media/index.js';
import type { MemoriahubPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The search slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client: it narrows `MEMORIAHUB_PRISMA` with the delegates it
// uses (structural and loose, as the media slice does).
// =============================================================================

/**
 * The models of the search slice.
 *
 * @stability experimental
 */
export interface SearchModels {
  /** `media_items`. */
  mediaItem: MediaDelegate;
  /** `people` (the agent resolves person names to ids). */
  person: MediaDelegate;
}

/**
 * The client a search provider holds: the port plus the search delegates.
 *
 * @stability experimental
 */
export type SearchDb = MemoriahubPrismaClientLike & SearchModels;
