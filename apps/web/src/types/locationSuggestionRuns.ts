// ---------------------------------------------------------------------------
// Location-Suggestion bulk accept/reject at scale — run domain types.
//
// Mirrors the backend `LocationSuggestionRunService.serializeRun` /
// `listRunItems` shapes exactly. All date-ish fields are typed as `string`
// because JSON transports ISO 8601 strings. Clones `types/trashEmptyRuns.ts`.
// ---------------------------------------------------------------------------

export type LocationSuggestionRunStatus =
  | 'evaluating'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type LocationSuggestionRunItemStatus =
  | 'matched'
  | 'processing'
  | 'applied'
  | 'failed'
  | 'skipped';

/** Which bulk action this run performs. */
export type LocationSuggestionRunAction = 'accept' | 'reject';

/** Serialized run row (counters included) returned by GET /location-suggestion-runs/:id. */
export interface LocationSuggestionRun {
  id: string;
  circleId: string;
  action: LocationSuggestionRunAction;
  threshold: number;
  status: LocationSuggestionRunStatus;
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
export interface LocationSuggestionRunDetail extends LocationSuggestionRun {
  itemStatusCounts: Record<string, number>;
}

/** Response of POST /media/location-suggestions/bulk-accept|bulk-reject (async run creation). */
export interface CreateLocationSuggestionRunResponse {
  runId: string;
  status: LocationSuggestionRunStatus;
  matchedCount: number;
}

/** Response of POST /location-suggestion-runs/:id/cancel. */
export interface CancelLocationSuggestionRunResponse {
  runId: string;
  status: LocationSuggestionRunStatus;
}

export interface LocationSuggestionRunItem {
  id: string;
  suggestionId: string;
  status: LocationSuggestionRunItemStatus;
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

export interface LocationSuggestionRunListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface LocationSuggestionRunItemsResponse {
  items: LocationSuggestionRunItem[];
  meta: LocationSuggestionRunListMeta;
}

export interface LocationSuggestionRunItemsQueryParams {
  status?: LocationSuggestionRunItemStatus;
  page?: number;
  pageSize?: number;
}
