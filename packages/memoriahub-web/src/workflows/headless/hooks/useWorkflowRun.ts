import { useState, useCallback } from 'react';
import type { WorkflowRunDetail } from '../types.js';
import { getWorkflowRun as getWorkflowRunApi } from '../services/workflows.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * Use Workflow Run Result.
 *
 * @stability experimental
 */
export interface UseWorkflowRunResult {
  /** The `run`. */
  run: WorkflowRunDetail | null;
  /** The `isLoading`. */
  isLoading: boolean;
  /** The `error`. */
  error: string | null;
  /** The `fetchRun`. */
  fetchRun: (runId: string) => Promise<void>;
}

/**
 * Fetch a single run's detail. The caller can poll live progress by invoking
 * `fetchRun` on an interval.
 *
 * @stability experimental
 */
export function useWorkflowRun(): UseWorkflowRunResult {
  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchRun = useCallback(async (runId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getWorkflowRunApi(runId);
      if (!isMounted()) return;
      setRun(response);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch workflow run';
      setError(message);
      setRun(null);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { run, isLoading, error, fetchRun };
}
