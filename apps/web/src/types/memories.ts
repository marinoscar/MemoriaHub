// ---------------------------------------------------------------------------
// Memories — client DTO types (epic #300, API in issue #307, web in #309)
//
// These mirror `apps/api/src/memories/api/dto/memory-response.dto.ts` EXACTLY.
// Every timestamp is an ISO 8601 string and there is no BigInt anywhere in the
// payload (see the DTO file's header for why), so nothing here needs coercion.
//
// The API's global TransformInterceptor wraps each handler return value as
// `{ data, meta: { timestamp } }`, and `api.get()` unwraps `data` — so a list's
// OWN pagination meta arrives at the top level of what the service returns,
// exactly like `MediaKeysetResponse`.
// ---------------------------------------------------------------------------

/**
 * The seven curated memory kinds. Mirrors the Prisma `MemoryType` enum; a value
 * the client does not recognise must degrade gracefully rather than crash (see
 * `MEMORY_TYPE_META`'s fallback), because the API can ship a new kind before
 * the web app knows about it.
 */
export type MemoryType =
  | 'on_this_day'
  | 'trip'
  | 'person_highlights'
  | 'person_over_years'
  | 'theme'
  | 'seasonal'
  | 'year_in_review';

/**
 * The CALLER's own state on a memory — never another user's.
 *
 * Cards carry `seen` + `favorited` only: `hidden` would be a constant `false`
 * there, because a hidden memory is filtered out of the list and the feed in
 * SQL. Detail adds it, since a direct link to a hidden memory still resolves
 * and the UI has to be able to offer "unhide".
 */
export interface MemoryMyState {
  seen: boolean;
  favorited: boolean;
}

export interface MemoryDetailMyState extends MemoryMyState {
  hidden: boolean;
}

/** Card projection shared by `GET /api/memories` and `GET /api/memories/feed`. */
export interface MemoryCard {
  id: string;
  type: MemoryType;
  title: string;
  subtitle: string | null;
  itemCount: number;
  /** ISO 8601 — start of the period the memory covers. */
  periodStart: string;
  /** ISO 8601 — end of the period the memory covers. */
  periodEnd: string;
  coverMediaItemId: string | null;
  /** Signed thumbnail URL; null when the cover item has no thumbnail yet. */
  coverThumbnailUrl: string | null;
  meta: unknown | null;
  myState: MemoryMyState;
  /** ISO 8601 — when curation created this memory. Drives the month headers. */
  generatedAt: string;
}

/**
 * Feed card = the list card plus a few item thumbnails, which the Home carousel
 * fans out behind the cover. Capped server-side (4 today).
 */
export interface MemoryFeedCard extends MemoryCard {
  itemThumbnailUrls: string[];
}

/** Keyset envelope for `GET /api/memories` — no COUNT, so no totals. */
export interface MemoryListMeta {
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MemoryListResponse {
  items: MemoryCard[];
  meta: MemoryListMeta;
}

export interface MemoryFeedResponse {
  items: MemoryFeedCard[];
}

/** One ordered photo/video inside a memory. */
export interface MemoryDetailItem {
  id: string;
  mediaItemId: string;
  position: number;
  mediaType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  capturedAt: string | null;
  thumbnailUrl: string | null;
}

/**
 * Full detail for `GET /api/memories/:id`. Items are returned in full — a
 * memory holds at most `memories.maxItemsPerMemory` (bounded 5–100) rows, so
 * there is nothing to paginate.
 */
export interface MemoryDetail extends Omit<MemoryCard, 'myState'> {
  circleId: string;
  myState: MemoryDetailMyState;
  narrative: string | null;
  titleSource: string;
  titleModel: string | null;
  personId: string | null;
  refreshedAt: string;
  expiresAt: string | null;
  items: MemoryDetailItem[];
}

/** Query for `GET /api/memories`. Keyset only — there is no `page` mode. */
export interface MemoryListParams {
  circleId: string;
  type?: MemoryType;
  /** Keeps memories whose covered period overlaps that UTC calendar year. */
  year?: number;
  /** `true` narrows to the caller's own favorites. */
  favorite?: boolean;
  cursor?: string | null;
  pageSize?: number;
}

/** Response for `POST /api/memories/:id/save-album`. */
export interface SaveMemoryAlbumResult {
  albumId: string;
}
