// ---------------------------------------------------------------------------
// Empty-Trash at scale — run domain types (issue #165)
//
// Mirrors the backend `TrashEmptyRunService.serializeRun` / `listRunItems`
// shapes exactly. All date-ish fields are typed as `string` because JSON
// transports ISO 8601 strings.
// ---------------------------------------------------------------------------

export type TrashEmptyRunStatus =
  | 'evaluating'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type TrashEmptyRunItemStatus = 'matched' | 'deleted' | 'failed' | 'skipped';

/** Serialized run row (counters included) returned by GET /trash-empty-runs/:id. */
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

/** Run detail adds the per-item status tally. */
export interface TrashEmptyRunDetail extends TrashEmptyRun {
  itemStatusCounts: Record<string, number>;
}

/** Response of POST /api/media/trash/empty (async run creation). */
export interface CreateTrashEmptyRunResponse {
  runId: string;
  status: TrashEmptyRunStatus;
  matchedCount: number;
}

/** Response of POST /trash-empty-runs/:id/cancel. */
export interface CancelTrashEmptyRunResponse {
  runId: string;
  status: TrashEmptyRunStatus;
}

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

export interface TrashEmptyRunListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface TrashEmptyRunItemsResponse {
  items: TrashEmptyRunItem[];
  meta: TrashEmptyRunListMeta;
}

export interface TrashEmptyRunItemsQueryParams {
  status?: TrashEmptyRunItemStatus;
  page?: number;
  pageSize?: number;
}
