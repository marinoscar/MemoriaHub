// ---------------------------------------------------------------------------
// Review-queue runs — one async run model for bursts, duplicates and location
// suggestions (issue #190).
//
// Mirrors the backend `ReviewRunService.serializeRun` / `listRunItems` shapes.
// Built on the shared `types/runs.ts` primitives rather than cloning
// `types/trashEmptyRuns.ts` a third time. All date-ish fields are `string`
// because JSON transports ISO 8601.
// ---------------------------------------------------------------------------

import type {
  BaseRun,
  BaseRunDetail,
  BaseRunItem,
  RunItemsQueryParams,
  RunListMeta,
  RunStatus,
} from './runs';

/** Which review queue a run belongs to. */
export type ReviewRunSubject = 'burst_group' | 'duplicate_group' | 'location_suggestion';

/**
 * The bulk action a run performs.
 *
 * `resolve_archive` / `resolve_trash` / `dismiss` apply to the burst and
 * duplicate queues; `accept` / `reject` to location suggestions.
 */
export type ReviewRunAction =
  | 'resolve_archive'
  | 'resolve_trash'
  | 'dismiss'
  | 'accept'
  | 'reject';

export type ReviewRunStatus = RunStatus;

/** Serialized run row returned by GET /review-runs/:id. */
export interface ReviewRun extends BaseRun {
  subjectType: ReviewRunSubject;
  action: ReviewRunAction;
  /** Confidence floor as an integer percent (0–100) snapshotted at evaluation. */
  threshold: number;
}

/** Run detail adds the per-item status tally. */
export interface ReviewRunDetail extends ReviewRun, BaseRunDetail {}

/** Response of the five threshold endpoints that start a review run. */
export interface CreateReviewRunResponse {
  runId: string;
  status: ReviewRunStatus;
  matchedCount: number;
}

/** Response of POST /review-runs/:id/cancel. */
export interface CancelReviewRunResponse {
  runId: string;
  status: ReviewRunStatus;
}

/**
 * One subject's outcome within a run.
 *
 * The backing table uses an exclusive arc — exactly one of
 * `burst_group_id` / `duplicate_group_id` / `location_suggestion_id` is
 * populated, matching the run's `subjectType`. That is a DATABASE-level
 * integrity concern; the API flattens it to a single `subjectId` before
 * serializing, so the client never sees the three columns.
 */
export interface ReviewRunItem extends BaseRunItem {
  subjectType: ReviewRunSubject;
  subjectId: string;
}

export type ReviewRunListMeta = RunListMeta;

export interface ReviewRunItemsResponse {
  items: ReviewRunItem[];
  meta: ReviewRunListMeta;
}

export type ReviewRunItemsQueryParams = RunItemsQueryParams;
