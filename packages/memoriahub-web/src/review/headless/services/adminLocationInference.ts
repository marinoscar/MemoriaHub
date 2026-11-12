import { api } from '../../../core/headless/index.js';

/**
 * The result of the global location inference backfill.
 *
 * @stability experimental
 */
export interface LocationInferenceBackfillResult {
  enqueued: number;
  circles: number;
  estimatedItems: number;
}

/**
 * Enqueues one location inference sweep per eligible circle (Admin + system_settings:write).
 *
 * @stability experimental
 */
export async function runGlobalLocationInferenceBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<LocationInferenceBackfillResult> {
  return api.post<LocationInferenceBackfillResult>('/admin/location-inference/backfill', body ?? {});
}
