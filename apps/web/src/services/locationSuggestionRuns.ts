import { api } from './api';
import type { CreateReviewRunResponse } from '../types/reviewRuns';

// ---------------------------------------------------------------------------
// Location-Suggestion bulk accept/reject — run START endpoints.
//
// These two endpoints now create a REVIEW RUN (issue #190): the old
// `location_suggestion_runs` table folded into the shared `review_runs` model,
// preserving run UUIDs. Reading a run, listing its items and cancelling it
// therefore go through `services/reviewRuns.ts` like every other review queue —
// this module is only the queue-specific way to START one.
//
// `threshold` is an INTEGER 0–100 (confidence percent floor).
// The `api` client auto-unwraps the `{ data }` envelope, so the return type
// below is the INNER object.
// ---------------------------------------------------------------------------

/** Start an async ACCEPT run: accept every pending suggestion at/above `threshold`. */
export async function startLocationAcceptRun(body: {
  circleId: string;
  threshold: number;
}): Promise<CreateReviewRunResponse> {
  return api.post<CreateReviewRunResponse>('/media/location-suggestions/bulk-accept', body);
}

/** Start an async REJECT run: reject every pending suggestion BELOW `threshold`. */
export async function startLocationRejectRun(body: {
  circleId: string;
  threshold: number;
}): Promise<CreateReviewRunResponse> {
  return api.post<CreateReviewRunResponse>('/media/location-suggestions/bulk-reject', body);
}
