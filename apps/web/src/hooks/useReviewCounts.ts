import { useState, useCallback, useEffect } from 'react';
import type { ReviewCountsResponse } from '../types/media';
import { getReviewCounts } from '../services/media';
import { useCircle } from './useCircle';
import { useIsMounted } from './useIsMounted';

interface UseReviewCountsOptions {
  /**
   * When false, the hook makes NO request and reports `data: null`.
   *
   * This exists because hooks cannot be called conditionally: a caller that
   * only needs these counts behind a feature gate (e.g. the sidebar's AI
   * Enhancements badge, gated on `features.pictureEnhancement`) must still
   * call the hook unconditionally. Passing `enabled: false` is how it opts
   * out of the network call without breaking the rules of hooks — see
   * issue #204.
   *
   * Flipping this back to true (e.g. once a feature flag finishes loading)
   * triggers the fetch, since `enabled` participates in the effect deps.
   *
   * Default: true.
   */
  enabled?: boolean;
}

interface UseReviewCountsResult {
  data: ReviewCountsResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetch the four review-queue counts for the active circle.
 *
 * The lightweight counterpart to `useDashboard` for surfaces that only need a
 * pending-work number for a badge: `GET /api/media/review-counts` returns four
 * integers, where the dashboard also returns On This Day / recent / favorites
 * with a signed thumbnail URL per item.
 */
export function useReviewCounts(
  options: UseReviewCountsOptions = {},
): UseReviewCountsResult {
  const { enabled = true } = options;
  const { activeCircleId } = useCircle();
  const [data, setData] = useState<ReviewCountsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetch = useCallback(async (circleId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getReviewCounts(circleId);
      if (!isMounted()) return;
      setData(response);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to load review counts';
      setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (!enabled || !activeCircleId) {
      setData(null);
      setIsLoading(false);
      return;
    }
    void fetch(activeCircleId);
  }, [enabled, activeCircleId, fetch]);

  const refetch = useCallback(() => {
    if (enabled && activeCircleId) {
      void fetch(activeCircleId);
    }
  }, [enabled, activeCircleId, fetch]);

  return { data, isLoading, error, refetch };
}
