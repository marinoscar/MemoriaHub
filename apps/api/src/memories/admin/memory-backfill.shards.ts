// =============================================================================
// Memories — library backfill shard plan (epic #300, issue #315)
// =============================================================================
//
// WHY A BACKFILL IS SHARDED AT ALL
// --------------------------------
// A scheduled `memory_generation` job is small by construction: On This Day
// curates two anchor days, Trips looks back `lookbackMonths`, the people/theme
// curators only touch the current and previous year. A BACKFILL deliberately
// removes every one of those horizons — that is what makes a 70k-item library
// light up with years of memories on day one — and the result is a single job
// whose work is proportional to the whole library.
//
// The worst offender is On This Day: up to 366 anchor days × `lookbackYears`
// curations, each a query plus a scored selection plus an upsert. #303 shipped
// that as ONE job and explicitly deferred chunking here, noting it can approach
// `ENRICHMENT_JOB_TIMEOUT_MS` (10 minutes by default). A job killed by that
// timeout is not just slow — it burns an attempt, and after
// `ENRICHMENT_MAX_ATTEMPTS` the backfill fails permanently having produced only
// whatever the first few minutes managed each time.
//
// So the backfill is split into bounded units, following the precedent set by
// `duplicate_detection_batch` (100 media items per job, chosen specifically to
// stay under the worker's stuck-job reset threshold). Every shard is a normal
// `memory_generation` row: retryable, observable in /admin/settings/jobs,
// claimable by any worker slot, and idempotent — a shard that fails and retries
// re-does only its own slice, because every curator write is an upsert keyed on
// `(circleId, type, periodKey, subjectKey)`.
//
// THE SHARD AXES, AND WHY THEY DIFFER PER CURATOR
// -----------------------------------------------
//  • On This Day is sharded BY CALENDAR MONTH (12 shards). Its cost scales with
//    the number of distinct (month, day) pairs the circle has photos on, and a
//    month is the natural bounded slice of that: at most 31 anchors × the
//    lookback years per shard. Nothing else needs an intra-curator split.
//  • Every other curator gets ITS OWN shard. Their backfills are bounded by
//    period count (years, seasons) or subject count (people, tags) rather than
//    by 366 calendar days, and one job each already bounds them well below the
//    timeout while buying per-type error isolation and letting several worker
//    slots run different types in parallel.
//
// Deliberately NOT sharded further by year/person/tag: that would multiply job
// rows for slices whose individual cost is already small, and each extra shard
// re-pays that curator's census query. Month-per-shard is the one place the
// arithmetic actually demanded it.
//
// WHY THE AI-TITLE BUDGET IS DIVIDED
// ----------------------------------
// #306's `BACKFILL_AI_TITLE_CAP` is a per-JOB ceiling, so N shards would
// silently become an N× larger bill for one admin click. The planner hands each
// shard `cap / shards` instead, keeping a sharded backfill's provider spend at
// roughly the unsharded figure the cap was chosen for. Every scheduled run
// afterwards gets a fresh, uncapped budget, so the library still converges on
// AI titles over time — which is exactly the convergence #306 designed for.
// =============================================================================

import { BACKFILL_AI_TITLE_CAP } from '../titles/memory-title.service';
import { MemoryGenerationPayload } from '../memory-generation.payload';

/** One bounded unit of a circle's library backfill. */
export interface MemoryBackfillShard {
  /** Stable identifier, used only in logs. */
  readonly label: string;
  /** Curator names this shard runs. */
  readonly curators: readonly string[];
  /** On This Day only: the calendar months this shard's anchors come from. */
  readonly anchorMonths?: readonly number[];
}

/** Curators that are cheap enough to backfill in one shard each. */
const SINGLE_SHARD_CURATORS = [
  'trip',
  'person_highlights',
  'person_over_years',
  'theme',
  'seasonal',
  'year_in_review',
] as const;

/**
 * The full shard plan for ONE circle: 12 On This Day months + one shard per
 * remaining curator = 18 `memory_generation` rows.
 *
 * Order matters — it is the order the rows are created in, and the queue claims
 * equal-priority jobs oldest-first, so the calendar months (the content users
 * see on Home first) run before the long-tail types.
 */
export const MEMORY_BACKFILL_SHARDS: readonly MemoryBackfillShard[] = [
  ...Array.from({ length: 12 }, (_unused, index): MemoryBackfillShard => {
    const month = index + 1;
    return {
      label: `on_this_day:month-${month}`,
      curators: ['on_this_day'],
      anchorMonths: [month],
    };
  }),
  ...SINGLE_SHARD_CURATORS.map((name): MemoryBackfillShard => ({
    label: name,
    curators: [name],
  })),
];

/**
 * Per-shard slice of #306's backfill AI-titling budget.
 *
 * Floored at 1 so a plan with more shards than the cap still lets every shard
 * title at least one memory rather than silently disabling AI titles wholesale.
 */
export const MEMORY_BACKFILL_AI_TITLE_CAP_PER_SHARD = Math.max(
  1,
  Math.floor(BACKFILL_AI_TITLE_CAP / MEMORY_BACKFILL_SHARDS.length),
);

/**
 * The payload for one shard, ready to hand to `EnrichmentJobService.enqueue`.
 *
 * Returned as `MemoryGenerationPayload & Record<string, unknown>` because
 * `enqueue()` types `payload` as an open record (it is JSONB) while the shape
 * above is a closed interface, which TypeScript will not widen on its own.
 */
export function memoryBackfillPayload(
  shard: MemoryBackfillShard,
): MemoryGenerationPayload & Record<string, unknown> {
  return {
    backfill: true,
    curators: [...shard.curators],
    ...(shard.anchorMonths ? { anchorMonths: [...shard.anchorMonths] } : {}),
    aiTitleCap: MEMORY_BACKFILL_AI_TITLE_CAP_PER_SHARD,
  };
}
