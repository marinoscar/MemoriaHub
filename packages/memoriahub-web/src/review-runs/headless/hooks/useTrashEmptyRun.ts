import { useState, useCallback } from 'react';
import type { TrashEmptyRunDetail } from '../../../media/headless/index.js';
import { getTrashEmptyRun as getTrashEmptyRunApi } from '../../../media/headless/index.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * The state and loader {@link useTrashEmptyRun} returns.
 *
 * @stability experimental
 */
export interface UseTrashEmptyRunResult {
  run: TrashEmptyRunDetail | null;
  isLoading: boolean;
  error: string | null;
  /** Loads (or reloads) the run; poll it with `useRunPolling`. */
  fetchRun: (runId: string) => Promise<void>;
}

/**
 * Fetch a single empty-trash run's detail. The caller can poll live progress by
 * invoking `fetchRun` on an interval (mirrors `useWorkflowRun`).
 *
 * @stability experimental
 */
export function useTrashEmptyRun(): UseTrashEmptyRunResult {
  const [run, setRun] = useState<TrashEmptyRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchRun = useCallback(async (runId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getTrashEmptyRunApi(runId);
      if (!isMounted()) return;
      setRun(response);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch trash-empty run';
      setError(message);
      setRun(null);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { run, isLoading, error, fetchRun };
}
