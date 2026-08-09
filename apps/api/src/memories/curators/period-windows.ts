// =============================================================================
// Memories — calendar period algebra (epic #300, issue #305)
// =============================================================================
//
// Pure UTC date arithmetic shared by the four curator families added in #305:
// year windows (person highlights, themes, year in review), month buckets
// (year in review's diversity policy) and season windows (seasonal).
//
// Zero I/O and zero Nest wiring, for the same reason `trip-clustering.ts` is
// split out of `trip.curator.ts`: the interesting behavior here is edge-case
// arithmetic — which calendar year a December photo's winter belongs to, which
// season "the most recently completed one" is on January 3rd — and it is worth
// testing directly rather than through a database fixture.
//
// EVERYTHING IS UTC. `Memory.periodStart`/`periodEnd` are `timestamptz`, the
// title templates format with an explicit `timeZone: 'UTC'`, and the base
// filter's `capturedAt` comparisons are instants. A curator computing "the year
// 2025" in the container's local zone would produce a window that shifts when
// the deployment moves — and a `periodKey` that disagrees with the title
// rendered from the same row.
//
// THE SEASON YEAR IS NOT THE CALENDAR YEAR. Northern-hemisphere meteorological
// winter spans December of year Y through February of Y+1, so a January photo
// belongs to *winter Y-1*. `seasonOf()` performs that reconciliation once,
// centrally; `seasonForMonth()` in memory-title-templates.ts answers only the
// simpler "which season is month N" and deliberately knows nothing about years.
// =============================================================================

import { SeasonKey, seasonForMonth } from '../curation/memory-title-templates';

/** A half-open `[start, endExclusive)` instant range. */
export interface PeriodWindow {
  start: Date;
  endExclusive: Date;
}

/** A season pinned to the calendar year it STARTS in. */
export interface SeasonPeriod {
  /** The year the season begins — December's winter is `winter` of THAT year. */
  year: number;
  season: SeasonKey;
}

/**
 * Chronological position of a season WITHIN its season-year.
 *
 * Spring/summer/fall/winter, not the calendar-alphabetical winter-first order,
 * because winter Y starts in December Y — i.e. AFTER fall Y. Ordering them any
 * other way makes `previousSeason()` silently skip a year: the season before
 * spring 2026 is winter 2025 (Dec 2025–Feb 2026), not fall 2024.
 */
const SEASON_ORDER: readonly SeasonKey[] = ['spring', 'summer', 'fall', 'winter'];

/** First month (1-based) of each season within its season-year. */
const SEASON_START_MONTH: Record<SeasonKey, number> = {
  spring: 3,
  summer: 6,
  fall: 9,
  winter: 12,
};

/** UTC calendar year of an instant. */
export function utcYear(date: Date): number {
  return date.getUTCFullYear();
}

/** `[Jan 1 year, Jan 1 year+1)` in UTC. */
export function yearWindow(year: number): PeriodWindow {
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    endExclusive: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

/**
 * Bucket key for `year_in_review`'s month diversity: `year * 12 + monthIndex`.
 *
 * Year-qualified rather than a bare 0–11 month so the key stays a total order
 * even if a caller ever hands it a range wider than one year — a bucket policy
 * that silently merged January 2024 with January 2025 would be a subtle bug in
 * exactly the kind of period this file exists to describe.
 */
export function monthBucket(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** Bucket key for `person_over_years`' year diversity. */
export function yearBucket(date: Date): number {
  return date.getUTCFullYear();
}

/** Which season an instant belongs to, with the December→next-year fold applied. */
export function seasonOf(date: Date): SeasonPeriod {
  const month = date.getUTCMonth() + 1;
  const season = seasonForMonth(month);
  // January and February belong to the winter that STARTED last December.
  const year = season === 'winter' && month <= 2 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return { year, season };
}

/** Monotonic ordinal so seasons can be compared and stepped through. */
export function seasonOrdinal(period: SeasonPeriod): number {
  return period.year * SEASON_ORDER.length + SEASON_ORDER.indexOf(period.season);
}

/** Inverse of `seasonOrdinal`. */
export function seasonFromOrdinal(ordinal: number): SeasonPeriod {
  const size = SEASON_ORDER.length;
  // Floor division, correct for negative ordinals too (year 0 is not special).
  const year = Math.floor(ordinal / size);
  return { year, season: SEASON_ORDER[ordinal - year * size]! };
}

/** The season immediately before `period`. */
export function previousSeason(period: SeasonPeriod): SeasonPeriod {
  return seasonFromOrdinal(seasonOrdinal(period) - 1);
}

/**
 * The most recent season that has fully ELAPSED as of `now`.
 *
 * The season containing `now` is deliberately excluded: a "Summer 2026" memory
 * generated in July would be a partial summer, and the next refresh would
 * rewrite it — churning the item set (and, from #306, an AI title) every single
 * generation run for three months.
 */
export function mostRecentCompletedSeason(now: Date): SeasonPeriod {
  return previousSeason(seasonOf(now));
}

/** `[first day of the season, first day of the next season)` in UTC. */
export function seasonWindow(period: SeasonPeriod): PeriodWindow {
  const startMonth = SEASON_START_MONTH[period.season];
  const start = new Date(Date.UTC(period.year, startMonth - 1, 1));
  // Winter is the only season whose three months cross a year boundary; using
  // month arithmetic (month + 3, which Date.UTC normalizes past 12) means that
  // rollover needs no special case here.
  const endExclusive = new Date(Date.UTC(period.year, startMonth - 1 + 3, 1));
  return { start, endExclusive };
}

/** `"2025-summer"` — the `seasonal` `periodKey` form. */
export function seasonPeriodKey(period: SeasonPeriod): string {
  return `${period.year}-${period.season}`;
}

/**
 * Every season from `from` through `to` inclusive, chronologically.
 *
 * Returns empty when `to` precedes `from`, which is what a circle whose only
 * photos are in the still-running season produces.
 */
export function enumerateSeasons(from: SeasonPeriod, to: SeasonPeriod): SeasonPeriod[] {
  const first = seasonOrdinal(from);
  const last = seasonOrdinal(to);
  const out: SeasonPeriod[] = [];
  for (let ordinal = first; ordinal <= last; ordinal += 1) out.push(seasonFromOrdinal(ordinal));
  return out;
}
