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

export interface InsightsSnapshot {
  status: 'ready' | 'empty';
  metrics: InsightsMetrics | null;
  computedAt: string | null;
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getInsights(): Promise<InsightsSnapshot> {
  return api.get<InsightsSnapshot>('/admin/insights');
}

export async function refreshInsights(): Promise<InsightsSnapshot> {
  return api.post<InsightsSnapshot>('/admin/insights/refresh');
}
