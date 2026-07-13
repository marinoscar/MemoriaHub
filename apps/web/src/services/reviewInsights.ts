import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-queue review metrics (identical shape for bursts and duplicates). */
export interface ReviewQueueMetrics {
  identified: number;
  pending: number;
  resolved: number;
  dismissed: number;
  archivedGroups: number;
  trashedGroups: number;
  itemsKept: number;
  itemsArchived: number;
  itemsDeleted: number;
}

export interface ReviewInsights {
  bursts: ReviewQueueMetrics;
  duplicates: ReviewQueueMetrics;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** GET /api/media/review-insights — synchronous, precomputed on read. */
export async function getReviewInsights(circleId: string): Promise<ReviewInsights> {
  const p = new URLSearchParams({ circleId });
  return api.get<ReviewInsights>(`/media/review-insights?${p.toString()}`);
}
