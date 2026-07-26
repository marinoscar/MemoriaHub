import { api, ApiError } from './api';
import type {
  CancelReviewRunResponse,
  ReviewRunDetail,
  ReviewRunItemsQueryParams,
  ReviewRunItemsResponse,
} from '../types/reviewRuns';

// ---------------------------------------------------------------------------
// Review-queue runs — API client (issue #190).
//
// One generic run surface for all three review queues, mirroring the
// trash-empty / location-suggestion precedent:
//   - /review-runs/:id[/...] (detail / items / cancel)
//
// Runs are STARTED by the per-queue threshold endpoints (see services/bursts,
// services/duplicates and services/locationSuggestionRuns) — this module only
// reads and cancels them.
//
// The `api` client auto-unwraps the `{ data }` envelope, so every return type
// below is the INNER object.
// ---------------------------------------------------------------------------

/** Get a single run's detail (counters + item status tally). */
export async function getReviewRun(runId: string): Promise<ReviewRunDetail> {
  return api.get<ReviewRunDetail>(`/review-runs/${runId}`);
}

/** List a run's items (paginated, signed thumbnails). */
export async function listReviewRunItems(
  runId: string,
  params?: ReviewRunItemsQueryParams,
): Promise<ReviewRunItemsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString();
  return api.get<ReviewRunItemsResponse>(`/review-runs/${runId}/items${qs ? `?${qs}` : ''}`);
}

/** Cancel a non-terminal run (circle collaborator). */
export async function cancelReviewRun(runId: string): Promise<CancelReviewRunResponse> {
  return api.post<CancelReviewRunResponse>(`/review-runs/${runId}/cancel`);
}

/**
 * Shown when a start-a-run call is rejected because that queue already has an
 * active run in this circle. The guard is per `(circle, subjectType)`, so a
 * burst run and a location run may overlap — only two runs of the SAME queue
 * collide, which is what this wording says.
 */
export const RUN_IN_PROGRESS_MESSAGE =
  'A bulk run is already in progress for this queue. Wait for it to finish before starting another.';

/**
 * Turn a failed run-start into something a user can act on.
 *
 * A 409 is not a failure so much as a scheduling conflict, and the raw server
 * message does not say what to do about it — every queue that starts a run
 * needs the same translation, so it lives here rather than being re-derived
 * per page.
 */
export function startRunErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409) return RUN_IN_PROGRESS_MESSAGE;
  return err instanceof Error ? err.message : fallback;
}
