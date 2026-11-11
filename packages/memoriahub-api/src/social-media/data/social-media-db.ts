import type { MediaDelegate } from '../../media/index.js';
import type { MemoriahubPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The social-media slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it
// uses; a delegate is structural and loose (the rows are the domain's `memoriahub-db` schema, which
// the host's generated client types for its own callers).
// =============================================================================

/**
 * The model delegates the social-media slice uses.
 *
 * @stability experimental
 */
export interface SocialMediaModels {
  /** The media items (`social_media_source`, the probe columns). */
  mediaItem: MediaDelegate;
  /** The per-item detection status. */
  mediaSocialStatus: MediaDelegate;
  /** The circle tags (`Social Media`, the platform tags). */
  tag: MediaDelegate;
  /** The item-to-tag join rows. */
  mediaTag: MediaDelegate;
}

/**
 * The database port narrowed to the social-media slice's delegates.
 *
 * @stability experimental
 */
export type SocialMediaDb = MemoriahubPrismaClientLike & SocialMediaModels;

/**
 * A transaction client narrowed to the same delegates.
 *
 * @stability experimental
 */
export type SocialMediaTx = SocialMediaModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;
