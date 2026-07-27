// ---------------------------------------------------------------------------
// Shared async-run domain types (issue #190).
//
// Four backends now expose the same "async run" shape — workflow runs,
// trash-empty runs, location-suggestion runs and the generic review runs —
// each with a `run` record carrying five counters, a status, and timestamps.
// `types/trashEmptyRuns.ts` and the since-deleted
// `types/locationSuggestionRuns.ts` were acknowledged clones of one another;
// this module is the single definition they (and every future run backend)
// narrow from.
//
// All date-ish fields are typed as `string` because JSON transports ISO 8601.
// ---------------------------------------------------------------------------

/**
 * Superset of every run status across all four backends.
 *
 * `awaiting_approval` and `expired` are workflow-only today; the trash-empty,
 * location-suggestion and review-run backends emit the other six. Keeping one
 * union means the shared formatters and progress panel handle any run.
 */
export type RunStatus =
  | 'evaluating'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * Superset of every run-item status across all four backends.
 *
 * - `matched` / `failed` / `skipped` are universal.
 * - `processing` is the crash-safe claim marker used wherever executing an item
 *   does not delete its row (location suggestions, review runs).
 * - `deleted` is trash-empty's terminal success state (the media row, and with
 *   it the run-item row, cascades away).
 * - `applied` / `partially_applied` / `excluded` come from workflows and the
 *   review runs.
 */
export type RunItemStatus =
  | 'matched'
  | 'processing'
  | 'excluded'
  | 'applied'
  | 'partially_applied'
  | 'deleted'
  | 'failed'
  | 'skipped';

/**
 * The run fields every backend serializes identically.
 *
 * Per-backend run types extend this and add their own discriminators
 * (`action`, `threshold`, `subjectType`, `workflowId`, …).
 */
export interface BaseRun {
  id: string;
  circleId: string;
  status: RunStatus;
  /** Subjects discovered during evaluation. */
  matchedCount: number;
  /**
   * Subjects the executor has reached a terminal decision on.
   *
   * NOTE: a TERMINAL run may legitimately finish with
   * `processedCount < matchedCount`. Subjects can be cascade-deleted mid-run
   * (a duplicate group dropping below the member floor, a suggestion vanishing
   * with its media item), which shrinks the work set. Finalization keys off
   * "no rows remain in matched/processing", never on
   * `processedCount === matchedCount`, so that gap is SUCCESS, not a stall.
   */
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  startedById: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

/** Run detail adds the live per-item status tally. */
export interface BaseRunDetail extends BaseRun {
  itemStatusCounts: Record<string, number>;
}

/** Pagination envelope shared by every run-items listing. */
export interface RunListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** The media summary run-item listings hydrate for display. */
export interface RunItemMedia {
  type: string;
  capturedAt: string | null;
  filename: string | null;
  width: number | null;
  height: number | null;
}

/** Fields every run-item row carries, regardless of subject. */
export interface BaseRunItem {
  id: string;
  status: RunItemStatus;
  error: string | null;
  updatedAt: string;
  media: RunItemMedia | null;
  thumbnailUrl: string | null;
}

/** Query params accepted by every run-items listing endpoint. */
export interface RunItemsQueryParams {
  status?: RunItemStatus;
  page?: number;
  pageSize?: number;
}
