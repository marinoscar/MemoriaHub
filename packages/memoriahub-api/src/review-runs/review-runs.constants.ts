import type { ReviewRunAction, ReviewRunSubject } from '@marinoscar/memoriahub-contract/review-runs';

// =============================================================================
// Statuses and row shapes of the review-run engine (RETRO-J9, #622)
// =============================================================================
//
// The strings equal the `ReviewRunStatus` and `ReviewRunItemStatus` enums of the schema fragment
// (`@marinoscar/memoriahub-db`); the slice holds them as constants because it imports no generated
// client. The subject and action vocabularies come from the contract (`REVIEW_RUN_SUBJECTS`,
// `REVIEW_RUN_ACTIONS`), which `apps/api/src/common/contract-enums.spec.ts` pins to the database enums.
// =============================================================================

/**
 * The statuses of a `review_runs` row.
 *
 * @stability experimental
 */
export const REVIEW_RUN_STATUS = {
  evaluating: 'evaluating',
  running: 'running',
  completed: 'completed',
  completed_with_errors: 'completed_with_errors',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

/**
 * A `review_runs` status.
 *
 * @stability experimental
 */
export type ReviewRunStatus = (typeof REVIEW_RUN_STATUS)[keyof typeof REVIEW_RUN_STATUS];

/**
 * The statuses of a `review_run_items` row.
 *
 * @stability experimental
 */
export const REVIEW_RUN_ITEM_STATUS = {
  matched: 'matched',
  processing: 'processing',
  applied: 'applied',
  failed: 'failed',
  skipped: 'skipped',
} as const;

/**
 * A `review_run_items` status.
 *
 * @stability experimental
 */
export type ReviewRunItemStatus = (typeof REVIEW_RUN_ITEM_STATUS)[keyof typeof REVIEW_RUN_ITEM_STATUS];

/**
 * A `review_runs` row as the slice reads it.
 *
 * @stability experimental
 */
export interface ReviewRunRow {
  id: string;
  circleId: string;
  subjectType: ReviewRunSubject;
  action: ReviewRunAction;
  threshold: number;
  status: ReviewRunStatus;
  matchedCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  startedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
}
