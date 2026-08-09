// =============================================================================
// Memories — per-user read-time preference filtering (epic #300, issue #307)
// =============================================================================
//
// The `user_settings.memories` namespace (hidden people, sensitive date ranges)
// is a READ-TIME filter, never a generation input. Generation is circle-scoped:
// one `Memory` row is shared by every member, so a personal preference cannot
// influence what gets curated without leaking one member's preferences into
// another member's feed. That is why the curators deliberately ignore this
// namespace (docs/specs/memories.md §4.9) and why the filtering lives here.
//
// V1 LIMITATION (epic #300, deliberate): a memory is dropped WHOLE. A hidden
// person removes `person_highlights` / `person_over_years` memories keyed to
// them, but a trip or theme memory that merely CONTAINS that person among many
// faces is not scrubbed at the item level.
// =============================================================================

import { MemoriesPreferencesValue } from '../../common/types/settings.types';

/** Just enough of a Memory row to decide whether a preference hides it. */
export interface PreferenceFilterableMemory {
  personId: string | null;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * A user's preferences pre-compiled into the exact shapes the per-row check
 * needs, so a page of 20 rows does not re-parse the same date strings 20 times.
 *
 * `hiddenPersonIds` becomes a Set (membership, not scan) and each date range
 * becomes a half-open `[startMs, endExclusiveMs)` millisecond interval.
 */
export interface ResolvedMemoryPreferences {
  hiddenPersonIds: Set<string>;
  hiddenRanges: Array<{ startMs: number; endExclusiveMs: number }>;
  emailDigestOptOut: boolean;
}

/** The identity value: nothing hidden. Shared, never mutated. */
export const NO_MEMORY_PREFERENCES: ResolvedMemoryPreferences = {
  hiddenPersonIds: new Set<string>(),
  hiddenRanges: [],
  emailDigestOptOut: false,
};

/** True when the resolved preferences cannot filter anything out. */
export function preferencesAreEmpty(prefs: ResolvedMemoryPreferences): boolean {
  return prefs.hiddenPersonIds.size === 0 && prefs.hiddenRanges.length === 0;
}

/**
 * Compile a stored `user_settings.memories` blob into the resolved form.
 *
 * Defensive by construction: this reads a JSONB blob that the schema validated
 * when it was WRITTEN, but an older row (or a hand-edited one) can hold
 * anything, and a malformed preference must degrade to "no filter" rather than
 * throw inside a list request. Every non-string / unparseable entry is skipped.
 *
 * A `YYYY-MM-DD` range is inclusive of both endpoints, so `to` is expanded to
 * the START of the following day and the comparison is half-open — the same
 * trick `expiresAt` uses for an anchor day (see on-this-day.curator.ts).
 */
export function resolveMemoryPreferences(
  stored: MemoriesPreferencesValue | undefined | null,
): ResolvedMemoryPreferences {
  if (!stored || typeof stored !== 'object') return NO_MEMORY_PREFERENCES;

  const hiddenPersonIds = new Set<string>();
  if (Array.isArray(stored.hiddenPersonIds)) {
    for (const id of stored.hiddenPersonIds) {
      if (typeof id === 'string' && id) hiddenPersonIds.add(id);
    }
  }

  const hiddenRanges: Array<{ startMs: number; endExclusiveMs: number }> = [];
  if (Array.isArray(stored.hiddenDateRanges)) {
    for (const range of stored.hiddenDateRanges) {
      if (!range || typeof range !== 'object') continue;
      const startMs = Date.parse(`${range.from}T00:00:00.000Z`);
      const endMs = Date.parse(`${range.to}T00:00:00.000Z`);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
      // `to` is INCLUSIVE, so the exclusive bound is the next UTC midnight.
      const endExclusiveMs = endMs + 24 * 60 * 60 * 1000;
      if (endExclusiveMs <= startMs) continue;
      hiddenRanges.push({ startMs, endExclusiveMs });
    }
  }

  return {
    hiddenPersonIds,
    hiddenRanges,
    emailDigestOptOut: stored.emailDigestOptOut === true,
  };
}

/**
 * True when this memory must be withheld from THIS user's list/feed.
 *
 * Two independent rules, OR-combined:
 *   1. the memory is keyed to a hidden person (`personId` match), or
 *   2. its covered capture window OVERLAPS a sensitive range. Overlap, not
 *      containment: a trip that merely crosses a hidden anniversary is exactly
 *      the case the user is trying not to be shown, so a partial hit counts.
 */
export function isMemoryHiddenByPreferences(
  memory: PreferenceFilterableMemory,
  prefs: ResolvedMemoryPreferences,
): boolean {
  if (memory.personId && prefs.hiddenPersonIds.has(memory.personId)) {
    return true;
  }
  if (prefs.hiddenRanges.length === 0) return false;

  const startMs = memory.periodStart.getTime();
  const endMs = memory.periodEnd.getTime();
  for (const range of prefs.hiddenRanges) {
    if (startMs < range.endExclusiveMs && endMs >= range.startMs) return true;
  }
  return false;
}
