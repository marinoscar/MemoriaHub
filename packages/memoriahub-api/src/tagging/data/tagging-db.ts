import type { MediaDelegate } from '../../media/index.js';
import type { MemoriahubPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The tagging slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// uses; a delegate is structural and loose (the rows are the domain's `memoriahub-db` schema, which
// the host's generated client types for its own callers).
// =============================================================================

/**
 * The models of the tagging slice. A transaction client has the same shape.
 *
 * @stability experimental
 */
export interface TaggingModels {
  /** `media_items`. */
  mediaItem: MediaDelegate;
  /** `media_tag_status`: the per-item tagging status. */
  mediaTagStatus: MediaDelegate;
  /** `tag_labels`: the admin-managed vocabulary. */
  tagLabel: MediaDelegate;
  /** `tags`. */
  tag: MediaDelegate;
  /** `media_tags`. */
  mediaTag: MediaDelegate;
  /** `media_transcripts`. */
  mediaTranscript: MediaDelegate;
  /** `faces` (the assigned people names the prompt and the embedding text carry). */
  face: MediaDelegate;
}

/**
 * The client a tagging provider holds: the port plus the tagging delegates.
 *
 * @stability experimental
 */
export type TaggingDb = MemoriahubPrismaClientLike & TaggingModels;

/**
 * A transaction client of {@link TaggingDb}.
 *
 * @stability experimental
 */
export type TaggingTx = TaggingModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;
