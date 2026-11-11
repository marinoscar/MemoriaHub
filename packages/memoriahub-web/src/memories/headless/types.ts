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

import type {
  MemoryCard as ContractMemoryCard,
  MemoryDetail as ContractMemoryDetail,
  MemoryDetailItem as ContractMemoryDetailItem,
  MemoryDetailMyState as ContractMemoryDetailMyState,
  MemoryFeed,
  MemoryFeedCard as ContractMemoryFeedCard,
  MemoryList,
  MemoryMyState as ContractMemoryMyState,
  MemoryTypeValue,
  SaveMemoryAlbumResult as ContractSaveMemoryAlbumResult,
} from '@marinoscar/memoriahub-contract/memories';

// The response shapes are the wire schemas of `@marinoscar/memoriahub-contract/memories`
// (inferred types), so the API handler and this client share one definition.

/**
 * One memory as a list or feed card shows it.
 *
 * @stability experimental
 */
export type MemoryCard = ContractMemoryCard;

/**
 * One memory with its narrative and ordered items.
 *
 * @stability experimental
 */
export type MemoryDetail = ContractMemoryDetail;

/**
 * One item of a memory in the detail payload.
 *
 * @stability experimental
 */
export type MemoryDetailItem = ContractMemoryDetailItem;

/**
 * The caller's own state of a memory in the detail payload.
 *
 * @stability experimental
 */
export type MemoryDetailMyState = ContractMemoryDetailMyState;

/**
 * A feed card: a card plus the item thumbnails of the fan effect.
 *
 * @stability experimental
 */
export type MemoryFeedCard = ContractMemoryFeedCard;

/**
 * The caller's seen and favorite state of a card.
 *
 * @stability experimental
 */
export type MemoryMyState = ContractMemoryMyState;

/**
 * The result of saving a memory as an album.
 *
 * @stability experimental
 */
export type SaveMemoryAlbumResult = ContractSaveMemoryAlbumResult;

/**
 * The seven curated memory kinds. A value the client does not recognise must
 * degrade gracefully rather than crash (see `MEMORY_TYPE_META`'s fallback),
 * because the API can ship a new kind before the web app knows about it.
 *
 * @stability experimental
 */
export type MemoryType = MemoryTypeValue;

/**
 * Keyset envelope for `GET /api/memories`: no COUNT, so no totals.
 *
 * @stability experimental
 */
export type MemoryListMeta = MemoryList['meta'];

/**
 * Memory List Response.
 *
 * @stability experimental
 */
export type MemoryListResponse = MemoryList;

/**
 * Memory Feed Response.
 *
 * @stability experimental
 */
export type MemoryFeedResponse = MemoryFeed;

/**
 * Query for `GET /api/memories`. Keyset only — there is no `page` mode.
 *
 * @stability experimental
 */
export interface MemoryListParams {
  /** The `circleId`. */
  circleId: string;
  /** The `type`. */
  type?: MemoryType;
  /** Keeps memories whose covered period overlaps that UTC calendar year. */
  year?: number;
  /** `true` narrows to the caller's own favorites. */
  favorite?: boolean;
  /** The `cursor`. */
  cursor?: string | null;
  /** The `pageSize`. */
  pageSize?: number;
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

/**
 * One inclusive sensitive-date window. Both bounds are `YYYY-MM-DD`.
 *
 * @stability experimental
 */
export interface MemoryHiddenDateRange {
  /** The `from`. */
  from: string;
  /** The `to`. */
  to: string;
}

/**
 * The `memories` namespace as it is stored and returned.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
 */
export interface MemoriesPreferencesPatch {
  /** The `hiddenPersonIds`. */
  hiddenPersonIds?: string[] | null;
  /** The `hiddenDateRanges`. */
  hiddenDateRanges?: MemoryHiddenDateRange[] | null;
  /** The `emailDigestOptOut`. */
  emailDigestOptOut?: boolean | null;
}

/**
 * Server-side caps, mirrored so the UI can refuse before the API 400s.
 *
 * @stability experimental
 */
export const MEMORIES_MAX_HIDDEN_PERSON_IDS = 200;
/**
 * MEMORIES MAX HIDDEN DATE RANGES.
 *
 * @stability experimental
 */
export const MEMORIES_MAX_HIDDEN_DATE_RANGES = 50;
