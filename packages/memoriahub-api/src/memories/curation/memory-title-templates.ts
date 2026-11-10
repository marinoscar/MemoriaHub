// =============================================================================
// Memories — deterministic title templates (epic #300, issue #303)
// =============================================================================
//
// Pure functions, zero I/O, no Nest wiring: given the facts a curator already
// knows, produce the `title` / `subtitle` pair that goes on the Memory row with
// `titleSource = 'template'`.
//
// WHY THESE EXIST EVEN THOUGH #306 ADDS AI TITLES. Templates are not a
// placeholder — they are the permanent floor of the feature. AI titling is
// gated on `memories.aiTitles.enabled` AND a configured `ai.features.memories`
// provider AND a successful, time-bounded model call; ANY of those three
// missing falls back here. On a deployment with no AI provider configured
// (a supported, documented configuration) these are the only titles that ever
// render, so they have to read well on their own rather than look like debug
// output.
//
// LOCALE. English, formatted through `Intl.DateTimeFormat('en', …)` with an
// explicit `timeZone: 'UTC'`. The UTC pin is load-bearing, not decorative: a
// memory's `periodStart` is a `timestamptz`, and formatting it in the server's
// local zone would render "December 31, 2024" or "January 1, 2025" for the same
// instant depending on where the container happens to run — i.e. a title that
// changes when you redeploy. Every curator computes its period boundaries in
// UTC, so formatting must agree.
// =============================================================================

/** A rendered template result. `subtitle` is null when the type has none. */
export interface MemoryTitleParts {
  title: string;
  subtitle: string | null;
}

/**
 * Season labels, and the month→season mapping, in ONE place.
 *
 * Northern-hemisphere meteorological seasons (Dec–Feb Winter, Mar–May Spring,
 * Jun–Aug Summer, Sep–Nov Fall), per the epic. Centralized deliberately: a
 * future hemisphere/locale configuration only has to replace this table, not
 * hunt for month arithmetic scattered through the seasonal curator (#305).
 */
export const SEASON_LABELS = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall',
} as const;

export type SeasonKey = keyof typeof SEASON_LABELS;

/**
 * Northern-hemisphere season for a 1-based month.
 *
 * December belongs to the winter that *starts* in that calendar year, which is
 * why the seasonal curator's `periodKey` (`"2025-winter"`) and the label year
 * can legitimately disagree with a naive `getUTCFullYear()` of a January photo.
 * That reconciliation belongs to the curator (#305); this function answers only
 * "which season is month N".
 */
export function seasonForMonth(month1Based: number): SeasonKey {
  if (month1Based === 12 || month1Based <= 2) return 'winter';
  if (month1Based <= 5) return 'spring';
  if (month1Based <= 8) return 'summer';
  return 'fall';
}

/** `1 → "1 year"`, `6 → "6 years"`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const monthDayYear = new Intl.DateTimeFormat('en', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const monthYear = new Intl.DateTimeFormat('en', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const monthOnly = new Intl.DateTimeFormat('en', {
  month: 'long',
  timeZone: 'UTC',
});

/** `"March 12, 2023"` — always UTC. */
export function formatLongDate(date: Date): string {
  return monthDayYear.format(date);
}

/** `"March 2023"` — always UTC. */
export function formatMonthYear(date: Date): string {
  return monthYear.format(date);
}

/**
 * Title-case a free-form tag name: `"golden sunsets" → "Golden Sunsets"`.
 *
 * Word-wise rather than sentence-case because tags are labels, not prose, and
 * the vocabulary is admin-curated so an all-lowercase entry is the norm. An
 * already-capitalized or acronym-ish tag is left alone beyond its first letter.
 */
export function titleCaseTag(tag: string): string {
  return tag
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * `on_this_day` — "On this day — 6 years ago" / "March 12, 2019".
 *
 * @param yearsAgo  how far back the source photos are (>= 1)
 * @param sourceDate any instant within the source day; formatted in UTC
 */
export function onThisDayTitle(yearsAgo: number, sourceDate: Date): MemoryTitleParts {
  return {
    title: `On this day — ${pluralize(yearsAgo, 'year')} ago`,
    subtitle: formatLongDate(sourceDate),
  };
}

/**
 * `trip` — "Trip to Guanacaste" / "March 2023" (or "March–April 2023").
 *
 * The place is whatever the trip curator (#304) resolved as dominant, already
 * narrowed to locality → admin1 → country by the caller; this function does not
 * re-derive it.
 */
export function tripTitle(place: string, start: Date, end: Date): MemoryTitleParts {
  const sameMonth =
    start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();

  let subtitle: string;
  if (sameMonth) {
    subtitle = formatMonthYear(start);
  } else if (sameYear) {
    // "March–April 2023" — one year suffix, en dash.
    subtitle = `${monthOnly.format(start)}–${formatMonthYear(end)}`;
  } else {
    // A trip spanning New Year needs both years to be unambiguous.
    subtitle = `${formatMonthYear(start)}–${formatMonthYear(end)}`;
  }

  return { title: `Trip to ${place}`, subtitle };
}

/**
 * `person_highlights` — "Best of Abuela" / "2025".
 *
 * A Person row may legitimately have a NULL `name` (an unlabeled cluster the
 * user has favorited but not yet named). Rendering "Best of null" or "Best of "
 * would be worse than a generic-but-warm fallback, so an unnamed person gets
 * "Best moments together" with no name at all.
 *
 * @param year the highlight year, or null for an all-time collection
 */
export function personHighlightsTitle(
  name: string | null | undefined,
  year: number | null,
): MemoryTitleParts {
  const trimmed = name?.trim();
  return {
    title: trimmed ? `Best of ${trimmed}` : 'Best moments together',
    subtitle: year === null ? null : String(year),
  };
}

/**
 * `person_over_years` — "Camila through the years" / "2016–2025".
 *
 * The unnamed-person fallback mirrors personHighlightsTitle's rationale.
 */
export function personOverYearsTitle(
  name: string | null | undefined,
  firstYear: number,
  lastYear: number,
): MemoryTitleParts {
  const trimmed = name?.trim();
  return {
    title: trimmed ? `${trimmed} through the years` : 'Through the years',
    // A single-year span reads "2025", not "2025–2025".
    subtitle: firstYear === lastYear ? String(firstYear) : `${firstYear}–${lastYear}`,
  };
}

/** `theme` — "Golden Sunsets" / "14 favorite moments". */
export function themeTitle(tag: string, count: number): MemoryTitleParts {
  return {
    title: titleCaseTag(tag),
    subtitle: `${pluralize(count, 'favorite moment')}`,
  };
}

/** `seasonal` — "Summer 2025". No subtitle: the title already says everything. */
export function seasonalTitle(season: SeasonKey, year: number): MemoryTitleParts {
  return { title: `${SEASON_LABELS[season]} ${year}`, subtitle: null };
}

/** `year_in_review` — "Your 2025 in review" / "42 highlights from the year". */
export function yearInReviewTitle(year: number, count: number): MemoryTitleParts {
  return {
    title: `Your ${year} in review`,
    subtitle: `${pluralize(count, 'highlight')} from the year`,
  };
}
