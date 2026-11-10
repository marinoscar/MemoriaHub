// ---------------------------------------------------------------------------
// Empty-Trash at scale — run domain types (issue #165)
//
// Mirrors the backend `TrashEmptyRunService.serializeRun` / `listRunItems`
// shapes exactly. All date-ish fields are typed as `string` because JSON
// transports ISO 8601 strings.
// ---------------------------------------------------------------------------

/**
 * Trash Empty Run Status.
 *
 * @stability experimental
 */
export type TrashEmptyRunStatus =
  | 'evaluating'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

/**
 * Trash Empty Run Item Status.
 *
 * @stability experimental
 */
export type TrashEmptyRunItemStatus = 'matched' | 'deleted' | 'failed' | 'skipped';

/**
 * Serialized run row (counters included) returned by GET /trash-empty-runs/:id.
 *
 * @stability experimental
 */
export interface TrashEmptyRun {
  id: string;
  circleId: string;
  status: TrashEmptyRunStatus;
  matchedCount: number;
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

/**
 * Run detail adds the per-item status tally.
 *
 * @stability experimental
 */
export interface TrashEmptyRunDetail extends TrashEmptyRun {
  itemStatusCounts: Record<string, number>;
}

/**
 * Response of POST /api/media/trash/empty (async run creation).
 *
 * @stability experimental
 */
export interface CreateTrashEmptyRunResponse {
  runId: string;
  status: TrashEmptyRunStatus;
  matchedCount: number;
}

/**
 * Response of POST /trash-empty-runs/:id/cancel.
 *
 * @stability experimental
 */
export interface CancelTrashEmptyRunResponse {
  runId: string;
  status: TrashEmptyRunStatus;
}

/**
 * Trash Empty Run Item.
 *
 * @stability experimental
 */
export interface TrashEmptyRunItem {
  id: string;
  mediaItemId: string;
  status: TrashEmptyRunItemStatus;
  error: string | null;
  updatedAt: string;
  media: {
    type: string;
    capturedAt: string | null;
    filename: string | null;
    width: number | null;
    height: number | null;
  } | null;
  thumbnailUrl: string | null;
}

/**
 * Trash Empty Run List Meta.
 *
 * @stability experimental
 */
export interface TrashEmptyRunListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * Trash Empty Run Items Response.
 *
 * @stability experimental
 */
export interface TrashEmptyRunItemsResponse {
  items: TrashEmptyRunItem[];
  meta: TrashEmptyRunListMeta;
}

/**
 * Trash Empty Run Items Query Params.
 *
 * @stability experimental
 */
export interface TrashEmptyRunItemsQueryParams {
  status?: TrashEmptyRunItemStatus;
  page?: number;
  pageSize?: number;
}
