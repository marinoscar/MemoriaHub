import { api } from './api';

export interface LocationInferenceBackfillResult {
  enqueued: number;
  circles: number;
  estimatedItems: number;
}

export async function runGlobalLocationInferenceBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<LocationInferenceBackfillResult> {
  return api.post<LocationInferenceBackfillResult>('/admin/location-inference/backfill', body ?? {});
}
