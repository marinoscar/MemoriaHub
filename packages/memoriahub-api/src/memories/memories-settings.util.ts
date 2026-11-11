// =============================================================================
// Memories: settings resolution (epic #300, issue #303)
// =============================================================================
//
// The `memories` system settings namespace returns as OPTIONAL, and it genuinely can be absent: the row
// is JSONB written before this namespace existed, and nothing back-fills it (that is exactly what makes
// the namespace migration-free). Curators must not each carry `?? 10` fallbacks for values the settings
// schema already defines a default for: that is three copies of the same number drifting apart, the
// pitfall docs/specs/memories.md section 9.3 already documents for this namespace.
//
// This resolves the namespace ONCE per generation job, deep-merging over DEFAULT_MEMORIES_SETTINGS, so
// every curator receives a fully-populated MemoriesSettingsValue and can read `settings.onThisDay.minItems`
// directly. The app's settings registry takes its defaults from this constant (one source).
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';

import { isFeatureEnabled } from '../core/index.js';
import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../ports/index.js';
import { MEMORIES_OPTIONS, type MemoriesHostOptions } from './host/memories-options.js';

/**
 * The `memories.*` system settings (generation, per-type curation, AI titling and the e-mail digest).
 *
 * @stability experimental
 */
export interface MemoriesSettingsValue {
  generation: { intervalHours: number };
  maxItemsPerMemory: number;
  aiTitles: { enabled: boolean };
  onThisDay: { enabled: boolean; lookbackYears: number; minItems: number };
  trips: { enabled: boolean; minDays: number; minItems: number; minDistanceKm: number; lookbackMonths: number };
  people: { enabled: boolean; favoritesOnly: boolean; minItems: number };
  themes: { enabled: boolean; minItems: number; maxPerPeriod: number };
  seasonal: { enabled: boolean; minItems: number };
  yearInReview: { enabled: boolean; minItems: number };
  digest: {
    enabled: boolean;
    frequency: 'off' | 'daily' | 'weekly' | 'monthly';
    sendHourUtc: number;
    imageTokenTtlDays: number;
  };
}

/**
 * The defaults of the `memories` namespace. Note the per-type `enabled` flags all default to `true`
 * while `features.memories` defaults to `false`: the master flag is the only off switch that matters
 * for a fresh install.
 *
 * @stability experimental
 */
export const DEFAULT_MEMORIES_SETTINGS: MemoriesSettingsValue = {
  generation: { intervalHours: 24 },
  maxItemsPerMemory: 30,
  aiTitles: { enabled: true },
  onThisDay: { enabled: true, lookbackYears: 10, minItems: 3 },
  trips: { enabled: true, minDays: 2, minItems: 10, minDistanceKm: 50, lookbackMonths: 18 },
  people: { enabled: true, favoritesOnly: true, minItems: 8 },
  themes: { enabled: true, minItems: 8, maxPerPeriod: 3 },
  seasonal: { enabled: true, minItems: 12 },
  yearInReview: { enabled: true, minItems: 15 },
  digest: { enabled: true, frequency: 'weekly', sendHourUtc: 8, imageTokenTtlDays: 30 },
};

const MEMORIES_KILL_SWITCH_ENV = 'MEMORIES_ENABLED';

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
 * Fill every `memories.*` value from defaults where the stored settings are silent. Never mutates the
 * input, and never returns a partially-populated group: a caller can dereference any documented key
 * unconditionally.
 *
 * @param stored - the stored namespace, possibly absent or partial.
 * @returns the complete settings.
 * @stability experimental
 */
export function resolveMemoriesSettings(
  stored: Partial<MemoriesSettingsValue> | undefined | null,
): MemoriesSettingsValue {
  const defaults = DEFAULT_MEMORIES_SETTINGS;
  return {
    generation: mergeGroup(defaults.generation, stored?.generation),
    maxItemsPerMemory: stored?.maxItemsPerMemory ?? defaults.maxItemsPerMemory,
    aiTitles: mergeGroup(defaults.aiTitles, stored?.aiTitles),
    onThisDay: mergeGroup(defaults.onThisDay, stored?.onThisDay),
    trips: mergeGroup(defaults.trips, stored?.trips),
    people: mergeGroup(defaults.people, stored?.people),
    themes: mergeGroup(defaults.themes, stored?.themes),
    seasonal: mergeGroup(defaults.seasonal, stored?.seasonal),
    yearInReview: mergeGroup(defaults.yearInReview, stored?.yearInReview),
    digest: mergeGroup(defaults.digest, stored?.digest),
  };
}

/**
 * The single feature gate and settings reader of the slice: `features.memories` AND the
 * `MEMORIES_ENABLED` kill switch AND the host's own switch, so the generation cron, the digest cron,
 * both handlers and the read API can never disagree about what "enabled" means.
 *
 * @stability experimental
 */
@Injectable()
export class MemoriesSettingsService {
  constructor(
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    @Inject(MEMORIES_OPTIONS) private readonly options: MemoriesHostOptions,
  ) {}

  /** True when Memories is on (the setting, the kill switch and the host's switch). */
  async enabled(): Promise<boolean> {
    if (this.options.enabled && this.options.enabled() === false) return false;
    return isFeatureEnabled(this.settings, 'memories', MEMORIES_KILL_SWITCH_ENV);
  }

  /** The `memories.*` settings, every value filled from the defaults. */
  async resolve(): Promise<MemoriesSettingsValue> {
    const { value } = await this.settings.readSystem<Partial<MemoriesSettingsValue> | undefined>('memories');
    return resolveMemoriesSettings(value);
  }
}
