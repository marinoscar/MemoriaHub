// =============================================================================
// Memories — settings resolution (epic #300, issue #303)
// =============================================================================
//
// `SystemSettingsService.getSettings()` returns `memories` as OPTIONAL, and it
// genuinely can be absent: the row is JSONB written before this namespace
// existed, and nothing back-fills it (that is exactly what makes the namespace
// migration-free). Curators must not each carry `?? 10` fallbacks for values the
// settings schema already defines a default for — that is three copies of the
// same number drifting apart, the pitfall docs/specs/memories.md §9.3 already
// documents for this namespace.
//
// This resolves the namespace ONCE per generation job, deep-merging over
// DEFAULT_SYSTEM_SETTINGS.memories, so every curator receives a fully-populated
// MemoriesSettingsValue and can read `settings.onThisDay.minItems` directly.
// =============================================================================

import {
  DEFAULT_SYSTEM_SETTINGS,
  MemoriesSettingsValue,
} from '../common/types/settings.types';

const DEFAULTS = DEFAULT_SYSTEM_SETTINGS.memories as MemoriesSettingsValue;

/** Merge one nested settings group over its defaults, ignoring undefined keys. */
function mergeGroup<T extends object>(defaults: T, partial: Partial<T> | undefined): T {
  if (!partial) return { ...defaults };
  const out = { ...defaults };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Fill every `memories.*` value from defaults where the stored settings are
 * silent. Never mutates the input, and never returns a partially-populated
 * group — a caller can dereference any documented key unconditionally.
 */
export function resolveMemoriesSettings(
  stored: Partial<MemoriesSettingsValue> | undefined | null,
): MemoriesSettingsValue {
  return {
    generation: mergeGroup(DEFAULTS.generation, stored?.generation),
    maxItemsPerMemory: stored?.maxItemsPerMemory ?? DEFAULTS.maxItemsPerMemory,
    aiTitles: mergeGroup(DEFAULTS.aiTitles, stored?.aiTitles),
    onThisDay: mergeGroup(DEFAULTS.onThisDay, stored?.onThisDay),
    trips: mergeGroup(DEFAULTS.trips, stored?.trips),
    people: mergeGroup(DEFAULTS.people, stored?.people),
    themes: mergeGroup(DEFAULTS.themes, stored?.themes),
    seasonal: mergeGroup(DEFAULTS.seasonal, stored?.seasonal),
    yearInReview: mergeGroup(DEFAULTS.yearInReview, stored?.yearInReview),
    digest: mergeGroup(DEFAULTS.digest, stored?.digest),
  };
}
