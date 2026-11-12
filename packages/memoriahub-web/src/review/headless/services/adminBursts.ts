import { api } from '../../../core/headless/index.js';

/**
 * The result of a global burst backfill: the jobs enqueued across the circles.
 *
 * @stability experimental
 */
export interface GlobalBackfillResult {
  /** Jobs enqueued. */
  enqueued: number;
  /** Circles the backfill covered. */
  circles: number;
}

/**
 * Enqueues burst detection for every eligible item of every circle (Admin + system_settings:write).
 *
 * @param body - an optional `capturedAt` range (ISO 8601) and `force` to redo processed items.
 * @returns what was enqueued.
 *
 * @stability experimental
 */
export async function runGlobalBurstBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/bursts/backfill', body ?? {});
}
