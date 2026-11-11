import type { ReviewRunAction, ReviewRunSubject } from '@marinoscar/memoriahub-contract/review-runs';

import type { ReviewRunRow } from './review-runs.constants.js';

// =============================================================================
// Per-subject behaviour of the shared review-run engine (issue #190, RETRO-J9 #622)
// =============================================================================
//
// `ReviewRunService` and the two generic handlers (`review_run_evaluate`, `review_run_execute_batch`) own
// the run lifecycle: concurrency guard, authorization, keyset-paged materialization, the matched ->
// processing -> terminal claim, atomic counters and the race-safe finalize. Everything that differs per
// review queue lives behind {@link ReviewRunSubjectStrategy}, so neither handler ever branches on
// `subjectType`.
//
// Strategies WRAP the existing per-subject primitives (the burst and duplicate review services, the
// location accept/reject transaction) rather than forking them, so a single-item resolve and a bulk run
// always apply identical side effects. Each queue's own slice (or the host, for a queue whose review
// service has not moved) registers its strategy with {@link ReviewRunSubjectRegistry}.
// =============================================================================

/**
 * Which nullable FK column on `review_run_items` a strategy populates.
 *
 * @stability experimental
 */
export type ReviewRunSubjectColumn = 'burstGroupId' | 'duplicateGroupId' | 'locationSuggestionId';

/**
 * Opaque keyset cursor handed back to the strategy on the next page.
 *
 * @stability experimental
 */
export type ReviewRunCursor = Record<string, unknown>;

/**
 * One keyset page of matched subject ids.
 *
 * @stability experimental
 */
export interface ReviewRunEvaluatePage {
  /** The subject ids. */
  subjectIds: string[];
  /** Cursor for the next page, or null when this strategy knows it is done. */
  nextCursor: ReviewRunCursor | null;
}

/**
 * Mutable accumulator threaded through a single `review_run_execute_batch` attempt. `executeItem`
 * pushes follow-up work here; `deferredEffects` drains it once every per-item transaction has committed,
 * so a rolled-back mutation can never leave an orphaned enrichment job behind, and so batch-level
 * effects (the burst dedup re-enqueue) fire once per batch rather than once per group.
 *
 * @stability experimental
 */
export interface ReviewRunExecutionContext {
  /** Media items whose coordinates were just written and need reverse-geocoding. */
  geocode: { mediaItemId: string; circleId: string }[];
  /** Media items freed from a burst group that should re-compete for dedup matches. */
  reenqueueDuplicateDetection: { mediaItemId: string; circleId: string }[];
}

/**
 * A fresh, empty execution context for one batch.
 *
 * @stability experimental
 */
export function createExecutionContext(): ReviewRunExecutionContext {
  return { geocode: [], reenqueueDuplicateDetection: [] };
}

/**
 * Display projection for one subject, used to hydrate `listRunItems` rows. The service turns `metadata`
 * into a signed thumbnail URL via one batched StorageObject query for the whole page.
 *
 * @stability experimental
 */
export interface ReviewRunSubjectPreview {
  /** The media item shown. */
  mediaItemId: string | null;
  /** `photo` or `video`. */
  type: string | null;
  /** The civil capture time. */
  capturedAt: Date | null;
  /** The original filename. */
  filename: string | null;
  /** Width in pixels. */
  width: number | null;
  /** Height in pixels. */
  height: number | null;
  /** The item's metadata JSON (carries the thumbnail key). */
  metadata: unknown;
}

/**
 * One review queue's behaviour inside the engine.
 *
 * @extensionPoint registry
 * @stability experimental
 */
export interface ReviewRunSubjectStrategy {
  /** The review queue this strategy serves. */
  readonly subject: ReviewRunSubject;

  /** The `review_run_items` column this strategy's subject ids live in. */
  readonly subjectColumn: ReviewRunSubjectColumn;

  /** Actions this queue accepts; anything else is rejected at run creation. */
  readonly supportedActions: readonly ReviewRunAction[];

  /**
   * One keyset page of subjects eligible for `run`. Implementations filter by the run's threshold and
   * pending status, and must return a strictly advancing cursor so the caller terminates.
   *
   * @param run - the run.
   * @param cursor - the cursor of the previous page, or null for the first.
   * @param pageSize - the page size.
   */
  evaluatePage(run: ReviewRunRow, cursor: ReviewRunCursor | null, pageSize: number): Promise<ReviewRunEvaluatePage>;

  /**
   * Applies the run's action to one subject. Returns `'applied'` on success and `'skipped'` when the
   * subject no longer exists or is no longer eligible (already resolved by hand, lost its suggested-best
   * member), never `'failed'` for those cases. Throwing is reserved for genuine errors, which the handler
   * records as `failed`.
   *
   * @param run - the run.
   * @param subjectId - the subject.
   * @param ctx - the batch accumulator.
   */
  executeItem(run: ReviewRunRow, subjectId: string, ctx: ReviewRunExecutionContext): Promise<'applied' | 'skipped'>;

  /**
   * Fires follow-up enqueues accumulated in `ctx`. Called once per batch AFTER every per-item transaction
   * has committed. Must never throw: a failed follow-up enqueue is not a failed batch.
   *
   * @param run - the run.
   * @param ctx - the batch accumulator.
   */
  deferredEffects?(run: ReviewRunRow, ctx: ReviewRunExecutionContext): Promise<void>;

  /**
   * Resolves subject ids to their display media rows for run-item listings.
   *
   * @param subjectIds - the subjects of one page.
   */
  hydrateItems(subjectIds: string[]): Promise<Map<string, ReviewRunSubjectPreview>>;
}
