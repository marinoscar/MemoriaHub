// =============================================================================
// Memories — the `memory_generation` job payload (epic #300, issues #302 + #315)
// =============================================================================
//
// Kept in its own dependency-free module so the admin backfill planner (which
// WRITES payloads) and the generation handler (which READS them) agree on one
// shape without either importing the other.
//
// A scheduled run writes NO payload at all: every field here is optional and
// every absent field means "the whole, unsharded, non-backfill behaviour". The
// hourly cron therefore keeps enqueuing bare rows exactly as it did in #302 and
// nothing about the sharding below leaks into it.
// =============================================================================

/** Payload shape for a `memory_generation` enrichment job. */
export interface MemoryGenerationPayload {
  /**
   * Admin library backfill (#315): widen every curator from "what matters
   * today" to "everything this circle's library supports". Scheduled runs never
   * set it.
   */
  backfill?: boolean;
  /**
   * Restrict this job to these curator names (#315 sharding). Absent or empty
   * means "run every enabled curator", which is what a scheduled run does.
   *
   * Names are `MemoryCurator.name` values (`on_this_day`, `trip`,
   * `person_highlights`, `person_over_years`, `theme`, `seasonal`,
   * `year_in_review`). An unknown name simply matches nothing — the handler
   * logs it rather than failing, so a payload written by an older release can
   * never poison the queue.
   */
  curators?: string[];
  /**
   * Restrict the On This Day curator's BACKFILL anchor set to these calendar
   * months (1–12). Absent means every month the circle has photos in.
   *
   * This is the axis a full-library backfill is sharded along — see
   * `admin/memory-backfill.shards.ts` for why On This Day is the one curator
   * that needs an intra-curator split.
   */
  anchorMonths?: number[];
  /**
   * This shard's slice of the run-wide AI-titling budget (#306's
   * `BACKFILL_AI_TITLE_CAP`).
   *
   * Sharding a backfill into N jobs would otherwise multiply that cap by N,
   * since the budget is per JOB. The planner divides it instead, so a sharded
   * backfill costs about the same number of provider calls as the single
   * unsharded job it replaced.
   */
  aiTitleCap?: number;
}

/** Months are 1-based calendar months; anything else is ignored. */
function isCalendarMonth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12;
}

/**
 * Coerce an untrusted `EnrichmentJob.payload` (JSONB, hand-editable from
 * `/admin/settings/jobs`, and possibly written by another release) into the
 * shape above.
 *
 * Every malformed field degrades to "absent", i.e. to the full unsharded
 * behaviour, rather than throwing: a payload problem must never cost a job its
 * retry budget over what is, in the worst case, doing MORE work than asked.
 */
export function parseMemoryGenerationPayload(raw: unknown): MemoryGenerationPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;

  const curators = Array.isArray(source['curators'])
    ? source['curators'].filter((name): name is string => typeof name === 'string' && name.length > 0)
    : undefined;

  const anchorMonths = Array.isArray(source['anchorMonths'])
    ? source['anchorMonths'].filter(isCalendarMonth)
    : undefined;

  const rawCap = source['aiTitleCap'];
  const aiTitleCap =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap >= 0
      ? Math.floor(rawCap)
      : undefined;

  return {
    backfill: source['backfill'] === true,
    ...(curators && curators.length > 0 ? { curators } : {}),
    ...(anchorMonths && anchorMonths.length > 0 ? { anchorMonths } : {}),
    ...(aiTitleCap !== undefined ? { aiTitleCap } : {}),
  };
}
