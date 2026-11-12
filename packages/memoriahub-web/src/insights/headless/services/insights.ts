import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The storage totals of one snapshot (byte fields are strings, counts are numbers).
 *
 * @stability experimental
 */
export interface InsightsMetrics {
  totalBytes: string;
  photoBytes: string;
  videoBytes: string;
  totalItems: number;
  photoCount: number;
  videoCount: number;
  totalFaces: number;
  taggedItems: number;
}

/**
 * The state of the refresh job: `idle`, `pending`, `running` or `failed`.
 *
 * @stability experimental
 */
export type InsightsRefreshState = 'idle' | 'pending' | 'running' | 'failed';

/**
 * The in-flight refresh job and its last error.
 *
 * @stability experimental
 */
export interface InsightsRefresh {
  state: InsightsRefreshState;
  jobId: string | null;
  lastError: string | null;
}

/**
 * The latest precomputed storage snapshot with the refresh state.
 *
 * @stability experimental
 */
export interface InsightsSnapshot {
  status: 'ready' | 'empty';
  metrics: InsightsMetrics | null;
  computedAt: string | null;
  durationMs: number | null;
  refresh: InsightsRefresh;
}

/**
 * The job a refresh request enqueued.
 *
 * @stability experimental
 */
export interface RefreshEnqueueResult {
  jobId: string;
  state: 'pending' | 'running';
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Reads the latest storage insights snapshot (admin only).
 *
 * @returns the snapshot and the refresh state
 *
 * @stability experimental
 */
export async function getInsights(): Promise<InsightsSnapshot> {
  return api.get<InsightsSnapshot>('/admin/insights');
}

/**
 * POST /api/admin/insights/refresh — enqueues a job and returns immediately.
 *
 * @stability experimental
 */
export async function refreshInsights(): Promise<RefreshEnqueueResult> {
  return api.post<RefreshEnqueueResult>('/admin/insights/refresh');
}
