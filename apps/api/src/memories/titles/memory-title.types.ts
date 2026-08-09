// =============================================================================
// Memories — AI titling types (epic #300, issue #306)
// =============================================================================
//
// Kept in its own dependency-free module so `curation/memory-curation.types.ts`
// can reference `MemoryTitleRun` without importing the title SERVICE, which in
// turn imports the curation types. Types-only files break that cycle at the
// source rather than relying on `import type` erasure to paper over it.
// =============================================================================

import { MemoryType } from '@prisma/client';

/**
 * Everything one titling attempt is allowed to know, assembled by the curation
 * service from the memory it is about to write.
 *
 * Deliberately a projection of `UpsertMemoryInput` rather than the input
 * itself: it names exactly what may travel toward a third-party model, which
 * makes the privacy boundary reviewable in one place. `circleId`, `userId`,
 * `personId`, storage keys and file names are absent BY CONSTRUCTION — see
 * memory-title.prompts.ts.
 */
export interface MemoryTitleRequest {
  type: MemoryType;
  /** The deterministic template title — the floor the model is asked to beat. */
  templateTitle: string;
  templateSubtitle: string | null;
  /** The curator's `meta` (place, personName, tag, season, yearsAgo, …). */
  meta: Record<string, unknown> | null;
  /** Media items in the memory. Used only for DB fact lookups — never sent. */
  mediaItemIds: string[];
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** A successful AI titling result, ready to write onto the `Memory` row. */
export interface MemoryAiTitle {
  title: string;
  subtitle: string | null;
  narrative: string | null;
  /** Persisted to `Memory.titleModel` so the row audits which model wrote it. */
  model: string;
}

/**
 * Mutable, per-generation-job budget and circuit breaker.
 *
 * WHY A PASSED OBJECT AND NOT SERVICE STATE. `MemoryTitleService` is a Nest
 * singleton and the enrichment worker can run several `memory_generation` jobs
 * concurrently (`ENRICHMENT_WORKER_CONCURRENCY`), so a mutable field on the
 * service would let one circle's rate-limit trip silently template another
 * circle's memories — and one circle's backfill would consume another's budget.
 * The run object is created once per job by `MemoryGenerationHandler`, carried
 * on `MemoryCuratorContext`, and handed to `upsertMemory` by each curator.
 *
 * A missing run means NO AI titling at all. That default is deliberately
 * fail-safe: a curator (or a test) that forgets to thread it degrades to the
 * documented template floor rather than making unbudgeted, uncapped model calls.
 */
export interface MemoryTitleRun {
  /** `memories.aiTitles.enabled`, resolved once per job. False ⇒ no call ever. */
  readonly enabled: boolean;
  /** True for an admin library backfill (#315), which is what caps the budget. */
  readonly backfill: boolean;
  /** Hard ceiling on provider calls for this job. `Infinity` outside backfill. */
  readonly maxAiCalls: number;
  /** Provider calls ATTEMPTED so far — a failed call still consumes budget. */
  aiCalls: number;
  /** Set once the run has stopped calling the provider for the rest of the job. */
  stopped: boolean;
  stopReason: MemoryTitleStopReason | null;
}

export type MemoryTitleStopReason = 'rate_limited' | 'budget_exhausted';
