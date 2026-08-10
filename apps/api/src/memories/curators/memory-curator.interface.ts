// =============================================================================
// Memories — curator contract (epic #300, issue #303)
// =============================================================================
//
// A curator answers one question: "which memories of MY type should exist in
// this circle right now?" It owns its slice selection, its identity keys
// (`periodKey`/`subjectKey`), its template titles and its own expiry/retention
// tail; it does NOT own scoring, near-duplicate collapse, diversity, or the
// idempotent write — those are MemoryCurationService's, shared by every type.
//
// The registry is an injected ARRAY rather than a hard-coded list inside the
// handler, so #304 (Trips) and #305 (People / Theme / Seasonal / Year in
// Review) add a provider and nothing else. The handler runs each entry inside
// its own try/catch — see MemoryGenerationHandler for why per-curator isolation
// is a correctness requirement, not politeness.
// =============================================================================

import { MemoriesSettingsValue } from '../../common/types/settings.types';
import type { MemoryTitleRun } from '../titles/memory-title.types';

/** DI token for the ordered curator registry. */
export const MEMORY_CURATORS = Symbol('MEMORY_CURATORS');

/** Everything a curator needs for one circle's generation pass. */
export interface MemoryCuratorContext {
  circleId: string;
  /**
   * The `memories.*` namespace with every default resolved, so a curator never
   * writes `?? 10` for a value the settings schema already defaults.
   */
  settings: MemoriesSettingsValue;
  /**
   * Wall clock for the whole run, captured ONCE by the handler and shared by
   * every curator. A run that straddles midnight must not have one curator
   * anchoring on today and the next on tomorrow.
   */
  now: Date;
  /**
   * Admin backfill (#315): widen from "what is relevant today" to "everything
   * this circle's library supports". Scheduled runs are always `false`.
   */
  backfill: boolean;
  /**
   * #315 backfill sharding: restrict the On This Day curator's anchor set to
   * these calendar months (1–12).
   *
   * Absent means "every month", which is what a scheduled run and an unsharded
   * backfill both do. It lives on the shared context rather than on a curator-
   * specific options object because the context is already the one channel
   * from `job.payload` to a curator, and only one curator reads it — inventing
   * a per-curator payload envelope for a single field would cost more than it
   * bought. A curator that does not shard by month simply ignores it.
   */
  anchorMonths?: number[];
  /**
   * The run's AI-titling budget and circuit breaker (#306), created ONCE by the
   * handler and shared by every curator so a provider rate limit stops the
   * whole job's titling and a backfill's 100-call cap is job-wide rather than
   * per curator.
   *
   * Every curator forwards it verbatim as `titling: ctx.titling` on its
   * `upsertMemory` call. Optional so a test can construct a context without it
   * — which yields template titles, the documented floor.
   */
  titling?: MemoryTitleRun;
}

/** What one curator did, for logging and the handler's run summary. */
export interface MemoryCuratorResult {
  created: number;
  refreshed: number;
  /** Periods that produced no memory (below `minItems`, or nothing to curate). */
  skipped: number;
  /** Upserts refused because the memory carries a user-delete tombstone. */
  tombstoned: number;
}

export function emptyCuratorResult(): MemoryCuratorResult {
  return { created: 0, refreshed: 0, skipped: 0, tombstoned: 0 };
}

export interface MemoryCurator {
  /** Stable identifier used in logs and error messages. */
  readonly name: string;

  /**
   * Per-type settings gate (`memories.<type>.enabled`). Kept on the curator
   * rather than as a settings key string on the registry entry so the mapping
   * from curator to setting is type-checked instead of stringly-typed.
   */
  isEnabled(settings: MemoriesSettingsValue): boolean;

  /** Generate/refresh this curator's memories for one circle. */
  run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult>;

  /**
   * Optional retention tail, run after `run()` on every generation job.
   *
   * Lives on the curator because retention is type-specific: only
   * `on_this_day` memories expire at all. Implemented as a hook rather than a
   * separate cron so it costs nothing on a deployment with the feature off, and
   * so a type's creation and cleanup rules stay in one file.
   *
   * @returns number of rows removed
   */
  purge?(ctx: MemoryCuratorContext): Promise<number>;
}
