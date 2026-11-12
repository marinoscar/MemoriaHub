import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-queue review metrics (identical shape for bursts and duplicates).
 *
 * @stability experimental
 */
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

/**
 * The review insights of one circle: the burst and duplicate queues.
 *
 * @stability experimental
 */
export interface ReviewInsights {
  bursts: ReviewQueueMetrics;
  duplicates: ReviewQueueMetrics;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Reads the review insights of one circle (computed live on every call).
 *
 * @param circleId - the circle (the active owner scope's id)
 * @returns the burst and duplicate queue metrics
 * @stability experimental
 */
export async function getReviewInsights(circleId: string): Promise<ReviewInsights> {
  const p = new URLSearchParams({ circleId });
  return api.get<ReviewInsights>(`/media/review-insights?${p.toString()}`);
}
