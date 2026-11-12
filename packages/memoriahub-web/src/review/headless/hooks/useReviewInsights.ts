import { useState, useCallback, useEffect } from 'react';
import { getReviewInsights } from '../services/reviewInsights.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { ReviewInsights } from '../services/reviewInsights.js';

/**
 * What {@link useReviewInsights} returns.
 *
 * @stability experimental
 */
export interface UseReviewInsightsResult {
  data: ReviewInsights | null;
  loading: boolean;
  error: string | null;
  /** Reloads the insights. */
  reload: () => Promise<void>;
}

/**
 * Hand-rolled fetch hook for the per-circle burst/duplicate review insights.
 * The endpoint is synchronous (computed on read), so there is no polling.
 *
 * @stability experimental
 */
export function useReviewInsights(circleId: string | null): UseReviewInsightsResult {
  const [data, setData] = useState<ReviewInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const reload = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getReviewInsights(circleId);
      if (!isMounted()) return;
      setData(result);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load review insights');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [circleId, isMounted]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
