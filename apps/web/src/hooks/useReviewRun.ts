import { useState, useCallback } from 'react';
import type { ReviewRunDetail } from '../types/reviewRuns';
import { getReviewRun as getReviewRunApi } from '../services/reviewRuns';

interface UseReviewRunResult {
  run: ReviewRunDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchRun: (runId: string) => Promise<void>;
}

/**
 * Fetch a single review run's detail. Live progress comes from polling
 * `fetchRun` via `useRunPolling` (mirrors `useTrashEmptyRun`).
 */
export function useReviewRun(): UseReviewRunResult {
  const [run, setRun] = useState<ReviewRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRun = useCallback(async (runId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getReviewRunApi(runId);
      setRun(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch review run';
      setError(message);
      setRun(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { run, isLoading, error, fetchRun };
}
