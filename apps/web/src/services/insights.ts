import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export type InsightsRefreshState = 'idle' | 'pending' | 'running' | 'failed';

export interface InsightsRefresh {
  state: InsightsRefreshState;
  jobId: string | null;
  lastError: string | null;
}

export interface InsightsSnapshot {
  status: 'ready' | 'empty';
  metrics: InsightsMetrics | null;
  computedAt: string | null;
  durationMs: number | null;
  refresh: InsightsRefresh;
}

export interface RefreshEnqueueResult {
  jobId: string;
  state: 'pending' | 'running';
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getInsights(): Promise<InsightsSnapshot> {
  return api.get<InsightsSnapshot>('/admin/insights');
}

/** POST /api/admin/insights/refresh — enqueues a job and returns immediately. */
export async function refreshInsights(): Promise<RefreshEnqueueResult> {
  return api.post<RefreshEnqueueResult>('/admin/insights/refresh');
}
