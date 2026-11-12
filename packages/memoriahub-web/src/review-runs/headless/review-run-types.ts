// ---------------------------------------------------------------------------
// Review-queue runs — one async run model for bursts, duplicates and location
// suggestions (issue #190).
//
// Mirrors the backend `ReviewRunService.serializeRun` / `listRunItems` shapes.
// Built on the shared `types/runs.ts` primitives rather than cloning
// `types/trashEmptyRuns.ts` a third time. All date-ish fields are `string`
// because JSON transports ISO 8601.
// ---------------------------------------------------------------------------

import type { ReviewRunAction, ReviewRunSubject } from '@marinoscar/memoriahub-contract/review-runs';
import type {
  BaseRun,
  BaseRunDetail,
  BaseRunItem,
  RunItemsQueryParams,
  RunListMeta,
  RunStatus,
} from './run-types.js';

// Which queue a run belongs to and the bulk action it performs come from
// `@marinoscar/memoriahub-contract/review-runs`, shared with the API.
export type { ReviewRunAction, ReviewRunSubject };

/**
 * The status of a review run (the shared run status union).
 *
 * @stability experimental
 */
export type ReviewRunStatus = RunStatus;

/**
 * Serialized run row returned by GET /review-runs/:id.
 *
 * @stability experimental
 */
export interface ReviewRun extends BaseRun {
  subjectType: ReviewRunSubject;
  action: ReviewRunAction;
  /** Confidence floor as an integer percent (0–100) snapshotted at evaluation. */
  threshold: number;
}

/**
 * Run detail adds the per-item status tally.
 *
 * @stability experimental
 */
export interface ReviewRunDetail extends ReviewRun, BaseRunDetail {}

/**
 * Response of the six threshold endpoints that start a review run: burst
 * resolve/dismiss, duplicate resolve/dismiss, location accept/reject.
 *
 * @stability experimental
 */
export interface CreateReviewRunResponse {
  runId: string;
  status: ReviewRunStatus;
  matchedCount: number;
}

/**
 * Response of POST /review-runs/:id/cancel.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
 */
export interface ReviewRunItem extends BaseRunItem {
  subjectType: ReviewRunSubject;
  subjectId: string;
}

/**
 * The pagination envelope of a review run's item listing.
 *
 * @stability experimental
 */
export type ReviewRunListMeta = RunListMeta;

/**
 * One page of a review run's items.
 *
 * @stability experimental
 */
export interface ReviewRunItemsResponse {
  items: ReviewRunItem[];
  meta: ReviewRunListMeta;
}

/**
 * The query parameters of a review run's item listing.
 *
 * @stability experimental
 */
export type ReviewRunItemsQueryParams = RunItemsQueryParams;
