import { api } from './api';
import type {
  CancelLocationSuggestionRunResponse,
  CreateLocationSuggestionRunResponse,
  LocationSuggestionRunDetail,
  LocationSuggestionRunItemsQueryParams,
  LocationSuggestionRunItemsResponse,
} from '../types/locationSuggestionRuns';

// ---------------------------------------------------------------------------
// Location-Suggestion bulk accept/reject at scale — run API client.
//
// Two base paths mirror the trash-empty / workflow-runs precedent:
//   - POST /media/location-suggestions/bulk-accept|bulk-reject (start a run)
//   - /location-suggestion-runs/:id[/...]                      (detail / items / cancel)
//
// `threshold` is an INTEGER 0–100 (confidence percent floor).
// The `api` client auto-unwraps the `{ data }` envelope, so every return type
// below is the INNER object.
// ---------------------------------------------------------------------------

/** Start an async ACCEPT run: accept every pending suggestion at/above `threshold`. */
export async function startLocationAcceptRun(body: {
  circleId: string;
  threshold: number;
}): Promise<CreateLocationSuggestionRunResponse> {
  return api.post<CreateLocationSuggestionRunResponse>(
    '/media/location-suggestions/bulk-accept',
    body,
  );
}

/** Start an async REJECT run: reject every pending suggestion at/above `threshold`. */
export async function startLocationRejectRun(body: {
  circleId: string;
  threshold: number;
}): Promise<CreateLocationSuggestionRunResponse> {
  return api.post<CreateLocationSuggestionRunResponse>(
    '/media/location-suggestions/bulk-reject',
    body,
  );
}

/** Get a single run's detail (counters + item status tally). */
export async function getLocationSuggestionRun(
  runId: string,
): Promise<LocationSuggestionRunDetail> {
  return api.get<LocationSuggestionRunDetail>(`/location-suggestion-runs/${runId}`);
}

/** List a run's items (paginated, signed thumbnails). */
export async function listLocationSuggestionRunItems(
  runId: string,
  params?: LocationSuggestionRunItemsQueryParams,
): Promise<LocationSuggestionRunItemsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString();
  return api.get<LocationSuggestionRunItemsResponse>(
    `/location-suggestion-runs/${runId}/items${qs ? `?${qs}` : ''}`,
  );
}

/** Cancel a non-terminal run (collaborator). */
export async function cancelLocationSuggestionRun(
  runId: string,
): Promise<CancelLocationSuggestionRunResponse> {
  return api.post<CancelLocationSuggestionRunResponse>(
    `/location-suggestion-runs/${runId}/cancel`,
  );
}
