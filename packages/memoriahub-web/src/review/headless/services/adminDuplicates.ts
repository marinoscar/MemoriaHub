import { api } from '../../../core/headless/index.js';

/**
 * The result of the global duplicate backfill: the jobs enqueued, the circles covered and the photos they span.
 *
 * @stability experimental
 */
export interface DuplicateBackfillResult {
  enqueued: number;
  circles: number;
  estimatedItems: number;
}

/**
 * Enqueues duplicate detection for every eligible photo of every circle (Admin + system_settings:write).
 *
 * @stability experimental
 */
export async function runGlobalDuplicatesBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<DuplicateBackfillResult> {
  return api.post<DuplicateBackfillResult>('/admin/duplicates/backfill', body ?? {});
}

/**
 * Whether the visual-embedding model is available; a degraded deployment matches by perceptual hash only.
 *
 * @stability experimental
 */
export interface DuplicatesModelStatus {
  modelAvailable: boolean;
  modelPath: string;
  degraded: boolean;
  model: string;
}

/**
 * Reads the visual-embedding model status (Admin + system_settings:read).
 *
 * @stability experimental
 */
export async function getDuplicatesStatus(): Promise<DuplicatesModelStatus> {
  return api.get<DuplicatesModelStatus>('/admin/duplicates/status');
}
