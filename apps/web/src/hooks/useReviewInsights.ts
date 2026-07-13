import { useState, useCallback, useEffect } from 'react';
import { getReviewInsights } from '../services/reviewInsights';
import type { ReviewInsights } from '../services/reviewInsights';

export interface UseReviewInsightsResult {
  data: ReviewInsights | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Hand-rolled fetch hook for the per-circle burst/duplicate review insights.
 * The endpoint is synchronous (computed on read), so there is no polling.
 */
export function useReviewInsights(circleId: string | null): UseReviewInsightsResult {
  const [data, setData] = useState<ReviewInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getReviewInsights(circleId);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review insights');
    } finally {
      setLoading(false);
    }
  }, [circleId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
