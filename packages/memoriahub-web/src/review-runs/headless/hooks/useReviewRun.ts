import { useState, useCallback } from 'react';
import type { ReviewRunDetail } from '../review-run-types.js';
import { getReviewRun as getReviewRunApi } from '../services/reviewRuns.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * The state and loader {@link useReviewRun} returns.
 *
 * @stability experimental
 */
export interface UseReviewRunResult {
  run: ReviewRunDetail | null;
  isLoading: boolean;
  error: string | null;
  /** Loads (or reloads) the run; poll it with `useRunPolling`. */
  fetchRun: (runId: string) => Promise<void>;
}

/**
 * Fetch a single review run's detail. Live progress comes from polling
 * `fetchRun` via `useRunPolling` (mirrors `useTrashEmptyRun`).
 *
 * @stability experimental
 */
export function useReviewRun(): UseReviewRunResult {
  const [run, setRun] = useState<ReviewRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchRun = useCallback(async (runId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getReviewRunApi(runId);
      if (!isMounted()) return;
      setRun(response);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch review run';
      setError(message);
      setRun(null);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { run, isLoading, error, fetchRun };
}
