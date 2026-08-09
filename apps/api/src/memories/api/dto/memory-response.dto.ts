import { MemoryType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
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

const memoryTypeSchema = z.nativeEnum(MemoryType);

/**
 * The caller's OWN state on a memory — never another user's.
 *
 * The CARD form carries `seen` + `favorited` only: `hidden` would be constant
 * `false` there, since a hidden memory is filtered out of the list and the feed
 * in SQL. Detail adds it, because detail deliberately still resolves a hidden
 * memory (a direct link must work) and the UI needs to offer "unhide".
 */
export const memoryMyStateSchema = z.object({
  seen: z.boolean(),
  favorited: z.boolean(),
});

export const memoryDetailMyStateSchema = memoryMyStateSchema.extend({
  hidden: z.boolean(),
});

/** Card projection used by both the list and the feed. */
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

export class MemoryCardDto extends createZodDto(memoryCardSchema) {}

/**
 * Feed card = the list card plus the first few item thumbnails, which the Home
 * carousel fans out behind the cover.
 */
export const memoryFeedCardSchema = memoryCardSchema.extend({
  itemThumbnailUrls: z.array(z.string()),
});

export class MemoryFeedCardDto extends createZodDto(memoryFeedCardSchema) {}

/** Keyset envelope for `GET /api/memories` — no COUNT, so no totals. */
export const memoryListSchema = z.object({
  items: z.array(memoryCardSchema),
  meta: z.object({
    pageSize: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export class MemoryListDto extends createZodDto(memoryListSchema) {}

/** Envelope for `GET /api/memories/feed` — a fixed, capped, uncursored list. */
export const memoryFeedSchema = z.object({
  items: z.array(memoryFeedCardSchema),
});

export class MemoryFeedDto extends createZodDto(memoryFeedSchema) {}

/** One ordered photo/video inside a memory. */
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

export class MemoryDetailItemDto extends createZodDto(memoryDetailItemSchema) {}

/**
 * Full detail for `GET /api/memories/:id`. Items are returned in full — a
 * memory holds at most `memories.maxItemsPerMemory` (bounded 5–100) rows, so
 * there is nothing to paginate.
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

export class MemoryDetailDto extends createZodDto(memoryDetailSchema) {}

/** Response for `POST /api/memories/:id/save-album`. */
export const saveMemoryAlbumResultSchema = z.object({
  albumId: z.string().uuid(),
});

export class SaveMemoryAlbumResultDto extends createZodDto(
  saveMemoryAlbumResultSchema,
) {}
