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

// ---------------------------------------------------------------------------
// Per-user memory preferences (issue #307's `user_settings.memories`
// namespace; the UI that reads and writes it is issue #313)
//
// Mirrors `memoriesPreferencesSchema` / `memoriesPreferencesPatchSchema` in
// `apps/api/src/common/schemas/settings.schema.ts`.
//
// THE ABSENT-KEY RULE IS LOAD-BEARING and identical to `notifications` and
// `dataTables`: every field is optional, the API never materializes one, and an
// absent key means "no preference" — nobody hidden, no sensitive range, digest
// NOT opted out of. Never model these as required-with-a-default on the client
// either: a defaulted local mirror is exactly what ends up PATCHing a fully
// materialized object back and pinning a user to today's defaults forever.
// ---------------------------------------------------------------------------

/** One inclusive sensitive-date window. Both bounds are `YYYY-MM-DD`. */
export interface MemoryHiddenDateRange {
  from: string;
  to: string;
}

/** The `memories` namespace as it is stored and returned. */
export interface MemoriesPreferences {
  /** Person ids whose memories are never shown to this user. */
  hiddenPersonIds?: string[];
  /** Memories overlapping any of these windows are never shown to this user. */
  hiddenDateRanges?: MemoryHiddenDateRange[];
  /** `true` = do not email me the memory digest. Absent means "send it". */
  emailDigestOptOut?: boolean;
}

/**
 * The `memories` namespace as accepted by `PATCH /api/user-settings`.
 *
 * Any field may be `null` to DELETE it (JSON Merge Patch), which resets it to
 * its absent default rather than pinning an explicit empty list / `false` that
 * would survive a future change of default.
 */
export interface MemoriesPreferencesPatch {
  hiddenPersonIds?: string[] | null;
  hiddenDateRanges?: MemoryHiddenDateRange[] | null;
  emailDigestOptOut?: boolean | null;
}

/** Server-side caps, mirrored so the UI can refuse before the API 400s. */
export const MEMORIES_MAX_HIDDEN_PERSON_IDS = 200;
export const MEMORIES_MAX_HIDDEN_DATE_RANGES = 50;
