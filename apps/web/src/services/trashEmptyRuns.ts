import { api } from './api';
import type {
  CancelTrashEmptyRunResponse,
  CreateTrashEmptyRunResponse,
  TrashEmptyRunDetail,
  TrashEmptyRunItemsQueryParams,
  TrashEmptyRunItemsResponse,
} from '../types/trashEmptyRuns';

// ---------------------------------------------------------------------------
// Empty-Trash at scale — run API client (issue #165)
//
// Two base paths mirror the workflow-runs precedent:
//   - POST /media/trash/empty     (start a run)
//   - /trash-empty-runs/:id[/...] (detail / items / cancel)
// ---------------------------------------------------------------------------

/** Start an async empty-trash run for a circle (circle_admin). */
export async function createTrashEmptyRun(body: {
  circleId: string;
}): Promise<CreateTrashEmptyRunResponse> {
  return api.post<CreateTrashEmptyRunResponse>('/media/trash/empty', body);
}

/** Get a single run's detail (counters + item status tally). */
export async function getTrashEmptyRun(runId: string): Promise<TrashEmptyRunDetail> {
  return api.get<TrashEmptyRunDetail>(`/trash-empty-runs/${runId}`);
}

/** List a run's items (paginated, signed thumbnails). */
export async function listTrashEmptyRunItems(
  runId: string,
  params?: TrashEmptyRunItemsQueryParams,
): Promise<TrashEmptyRunItemsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString();
  return api.get<TrashEmptyRunItemsResponse>(
    `/trash-empty-runs/${runId}/items${qs ? `?${qs}` : ''}`,
  );
}

/** Cancel a non-terminal run (circle_admin). */
export async function cancelTrashEmptyRun(
  runId: string,
): Promise<CancelTrashEmptyRunResponse> {
  return api.post<CancelTrashEmptyRunResponse>(`/trash-empty-runs/${runId}/cancel`);
}
