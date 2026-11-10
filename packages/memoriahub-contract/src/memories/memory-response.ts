import { memoryTypeSchema } from './memory-type.js';
import { z } from 'zod';


/**
 * Response shapes for the Memories API (epic #300, issue #307).
 *
 * NOTE: these describe the HANDLER's return value, not the wire format. The
 * global TransformInterceptor wraps every one of them as
 * `{ data: <this>, meta: { timestamp } }`, so a list's own pagination meta
 * lands at `data.meta` — the same shape `GET /api/media` and
 * `GET /api/notifications` already produce.
 *
 * Every timestamp is an ISO 8601 STRING, and there is no BigInt anywhere in
 * these payloads (the repo's BigInt-serialization gotcha): the only BigInt
 * column near this feature is `storage_objects.size`, which nothing here
 * selects, and `MediaItem.durationMs` is a plain `Int?`.
 */


/**
 * The caller's OWN state on a memory — never another user's.
 *
 * The CARD form carries `seen` + `favorited` only: `hidden` would be constant
 * `false` there, since a hidden memory is filtered out of the list and the feed
 * in SQL. Detail adds it, because detail deliberately still resolves a hidden
 * memory (a direct link must work) and the UI needs to offer "unhide".
 *
 * @stability experimental
 */
export const memoryMyStateSchema = z.object({
  seen: z.boolean(),
  favorited: z.boolean(),
});

/**
 * Wire schema `memoryDetailMyStateSchema`.
 *
 * @stability experimental
 */
export const memoryDetailMyStateSchema = memoryMyStateSchema.extend({
  hidden: z.boolean(),
});

/**
 * Card projection used by both the list and the feed.
 *
 * @stability experimental
 */
export const memoryCardSchema = z.object({
  id: z.string().uuid(),
  type: memoryTypeSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  itemCount: z.number().int(),
  periodStart: z.string(),
  periodEnd: z.string(),
  coverMediaItemId: z.string().uuid().nullable(),
  coverThumbnailUrl: z.string().nullable(),
  meta: z.unknown().nullable(),
  myState: memoryMyStateSchema,
  generatedAt: z.string(),
});


/**
 * Feed card = the list card plus the first few item thumbnails, which the Home
 * carousel fans out behind the cover.
 *
 * @stability experimental
 */
export const memoryFeedCardSchema = memoryCardSchema.extend({
  itemThumbnailUrls: z.array(z.string()),
});


/**
 * Keyset envelope for `GET /api/memories` — no COUNT, so no totals.
 *
 * @stability experimental
 */
export const memoryListSchema = z.object({
  items: z.array(memoryCardSchema),
  meta: z.object({
    pageSize: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});


/**
 * Envelope for `GET /api/memories/feed` — a fixed, capped, uncursored list.
 *
 * @stability experimental
 */
export const memoryFeedSchema = z.object({
  items: z.array(memoryFeedCardSchema),
});


/**
 * One ordered photo/video inside a memory.
 *
 * @stability experimental
 */
export const memoryDetailItemSchema = z.object({
  id: z.string().uuid(),
  mediaItemId: z.string().uuid(),
  position: z.number().int(),
  mediaType: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  capturedAt: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});


/**
 * Full detail for `GET /api/memories/:id`. Items are returned in full — a
 * memory holds at most `memories.maxItemsPerMemory` (bounded 5–100) rows, so
 * there is nothing to paginate.
 *
 * @stability experimental
 */
export const memoryDetailSchema = memoryCardSchema.extend({
  circleId: z.string().uuid(),
  myState: memoryDetailMyStateSchema,
  narrative: z.string().nullable(),
  titleSource: z.string(),
  titleModel: z.string().nullable(),
  personId: z.string().uuid().nullable(),
  refreshedAt: z.string(),
  expiresAt: z.string().nullable(),
  items: z.array(memoryDetailItemSchema),
});


/**
 * Response for `POST /api/memories/:id/save-album`.
 *
 * @stability experimental
 */
export const saveMemoryAlbumResultSchema = z.object({
  albumId: z.string().uuid(),
});

/**
 * The parsed value of {@link memoryMyStateSchema}.
 *
 * @stability experimental
 */
export type MemoryMyState = z.infer<typeof memoryMyStateSchema>;

/**
 * The parsed value of {@link memoryDetailMyStateSchema}.
 *
 * @stability experimental
 */
export type MemoryDetailMyState = z.infer<typeof memoryDetailMyStateSchema>;

/**
 * The parsed value of {@link memoryCardSchema}.
 *
 * @stability experimental
 */
export type MemoryCard = z.infer<typeof memoryCardSchema>;

/**
 * The parsed value of {@link memoryFeedCardSchema}.
 *
 * @stability experimental
 */
export type MemoryFeedCard = z.infer<typeof memoryFeedCardSchema>;

/**
 * The parsed value of {@link memoryListSchema}.
 *
 * @stability experimental
 */
export type MemoryList = z.infer<typeof memoryListSchema>;

/**
 * The parsed value of {@link memoryFeedSchema}.
 *
 * @stability experimental
 */
export type MemoryFeed = z.infer<typeof memoryFeedSchema>;

/**
 * The parsed value of {@link memoryDetailItemSchema}.
 *
 * @stability experimental
 */
export type MemoryDetailItem = z.infer<typeof memoryDetailItemSchema>;

/**
 * The parsed value of {@link memoryDetailSchema}.
 *
 * @stability experimental
 */
export type MemoryDetail = z.infer<typeof memoryDetailSchema>;

/**
 * The parsed value of {@link saveMemoryAlbumResultSchema}.
 *
 * @stability experimental
 */
export type SaveMemoryAlbumResult = z.infer<typeof saveMemoryAlbumResultSchema>;
