import { useState, useCallback } from 'react';
import type { TrashEmptyRunDetail } from '../types/trashEmptyRuns';
import { getTrashEmptyRun as getTrashEmptyRunApi } from '../services/trashEmptyRuns';

interface UseTrashEmptyRunResult {
  run: TrashEmptyRunDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchRun: (runId: string) => Promise<void>;
}

/**
 * Fetch a single empty-trash run's detail. The caller can poll live progress by
 * invoking `fetchRun` on an interval (mirrors `useWorkflowRun`).
 */
export function useTrashEmptyRun(): UseTrashEmptyRunResult {
  const [run, setRun] = useState<TrashEmptyRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRun = useCallback(async (runId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getTrashEmptyRunApi(runId);
      setRun(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch trash-empty run';
      setError(message);
      setRun(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { run, isLoading, error, fetchRun };
}
