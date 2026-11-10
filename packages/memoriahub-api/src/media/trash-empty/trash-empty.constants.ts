// =============================================================================
// Statuses of an empty-trash run (issue #165)
// =============================================================================
//
// The strings equal the `TrashEmptyRunStatus` and `TrashEmptyRunItemStatus` enums of the schema fragment
// (`@marinoscar/memoriahub-db`); the slice holds them as constants because it imports no generated client.
// =============================================================================

/**
 * The statuses of a `trash_empty_runs` row.
 *
 * @stability experimental
 */
export const TRASH_EMPTY_RUN_STATUS = {
  evaluating: 'evaluating',
  running: 'running',
  completed: 'completed',
  completed_with_errors: 'completed_with_errors',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

/**
 * A `trash_empty_runs` status.
 *
 * @stability experimental
 */
export type TrashEmptyRunStatus = (typeof TRASH_EMPTY_RUN_STATUS)[keyof typeof TRASH_EMPTY_RUN_STATUS];

/**
 * The statuses of a `trash_empty_run_items` row.
 *
 * @stability experimental
 */
export const TRASH_EMPTY_ITEM_STATUS = {
  matched: 'matched',
  deleted: 'deleted',
  failed: 'failed',
  skipped: 'skipped',
} as const;

/**
 * A `trash_empty_run_items` status.
 *
 * @stability experimental
 */
export type TrashEmptyRunItemStatus = (typeof TRASH_EMPTY_ITEM_STATUS)[keyof typeof TRASH_EMPTY_ITEM_STATUS];

/**
 * A `trash_empty_runs` row as the slice reads it.
 *
 * @stability experimental
 */
export interface TrashEmptyRunRow {
  id: string;
  circleId: string;
  status: TrashEmptyRunStatus;
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
