import { Prisma, ReviewRun, ReviewRunAction, ReviewRunSubject } from '@prisma/client';

/**
 * Per-subject behaviour for the shared review-run engine (issue #190).
 *
 * `ReviewRunService` + the two generic handlers (`review_run_evaluate`,
 * `review_run_execute_batch`) own the run lifecycle — concurrency guard,
 * authorization, keyset-paged materialization, the matched -> processing ->
 * terminal claim, atomic counters and the race-safe finalize. Everything that
 * differs per review queue lives behind this interface, so neither handler ever
 * branches on `subjectType`.
 *
 * Strategies WRAP the existing per-subject primitives (`BurstService`,
 * `DuplicateService`, the location accept/reject transaction) rather than
 * forking them, so a single-item resolve and a bulk run always apply identical
 * side-effects.
 */

/** Which nullable FK column on `review_run_items` a strategy populates. */
export type ReviewRunSubjectColumn =
  | 'burstGroupId'
  | 'duplicateGroupId'
  | 'locationSuggestionId';

/** Opaque keyset cursor handed back to the strategy on the next page. */
export type ReviewRunCursor = Record<string, unknown>;

/** One keyset page of matched subject ids. */
export interface ReviewRunEvaluatePage {
  subjectIds: string[];
  /** Cursor for the next page, or null when this strategy knows it is done. */
  nextCursor: ReviewRunCursor | null;
}

/**
 * Mutable accumulator threaded through a single `review_run_execute_batch`
 * attempt. `executeItem` pushes follow-up work here; `deferredEffects` drains it
 * once every per-item transaction has committed, so a rolled-back mutation can
 * never leave an orphaned enrichment job behind — and so batch-level effects
 * (e.g. the burst dedup re-enqueue) fire once per batch rather than once per
 * group.
 */
export interface ReviewRunExecutionContext {
  /** Media items whose coordinates were just written and need reverse-geocoding. */
  geocode: { mediaItemId: string; circleId: string }[];
  /** Media items freed from a burst group that should re-compete for dedup matches. */
  reenqueueDuplicateDetection: { mediaItemId: string; circleId: string }[];
}

export function createExecutionContext(): ReviewRunExecutionContext {
  return { geocode: [], reenqueueDuplicateDetection: [] };
}

/**
 * Display projection for one subject, used to hydrate `listRunItems` rows. The
 * service turns `metadata` into a signed thumbnail URL via one batched
 * StorageObject query for the whole page.
 */
export interface ReviewRunSubjectPreview {
  mediaItemId: string | null;
  type: string | null;
  capturedAt: Date | null;
  filename: string | null;
  width: number | null;
  height: number | null;
  metadata: Prisma.JsonValue | null;
}

export interface ReviewRunSubjectStrategy {
  /** The review queue this strategy serves. */
  readonly subject: ReviewRunSubject;

  /** The `review_run_items` column this strategy's subject ids live in. */
  readonly subjectColumn: ReviewRunSubjectColumn;

  /** Actions this queue accepts; anything else is rejected at run creation. */
  readonly supportedActions: readonly ReviewRunAction[];

  /**
   * One keyset page of subjects eligible for `run`. Implementations filter by
   * the run's threshold and pending status, and must return a strictly
   * advancing cursor so the caller terminates.
   */
  evaluatePage(
    run: ReviewRun,
    cursor: ReviewRunCursor | null,
    pageSize: number,
  ): Promise<ReviewRunEvaluatePage>;

  /**
   * Apply the run's action to one subject.
   *
   * Returns `'applied'` on success and `'skipped'` when the subject no longer
   * exists or is no longer eligible (already resolved by hand, lost its
   * suggested-best member, …) — never `'failed'` for those cases. Throwing is
   * reserved for genuine errors, which the handler records as `failed`.
   */
  executeItem(
    run: ReviewRun,
    subjectId: string,
    ctx: ReviewRunExecutionContext,
  ): Promise<'applied' | 'skipped'>;

  /**
   * Fire follow-up enqueues accumulated in `ctx`. Called once per batch AFTER
   * every per-item transaction has committed. Must never throw — a failed
   * follow-up enqueue is not a failed batch.
   */
  deferredEffects?(run: ReviewRun, ctx: ReviewRunExecutionContext): Promise<void>;

  /** Resolve subject ids to their display media rows for run-item listings. */
  hydrateItems(subjectIds: string[]): Promise<Map<string, ReviewRunSubjectPreview>>;
}
