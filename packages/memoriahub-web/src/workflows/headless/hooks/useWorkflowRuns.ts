import { useState, useCallback } from 'react';
import type {
  WorkflowRun,
  WorkflowListMeta,
  RunsQueryParams,
} from '../types.js';
import { listWorkflowRuns as listWorkflowRunsApi } from '../services/workflows.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * Use Workflow Runs Result.
 *
 * @stability experimental
 */
export interface UseWorkflowRunsResult {
  /** The `runs`. */
  runs: WorkflowRun[];
  /** The `meta`. */
  meta: WorkflowListMeta | null;
  /** The `isLoading`. */
  isLoading: boolean;
  /** The `error`. */
  error: string | null;
  /** The `fetchRuns`. */
  fetchRuns: (id: string, params?: RunsQueryParams) => Promise<void>;
}

/**
 * Use Workflow Runs.
 *
 * @stability experimental
 */
export function useWorkflowRuns(): UseWorkflowRunsResult {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [meta, setMeta] = useState<WorkflowListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchRuns = useCallback(async (id: string, params?: RunsQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listWorkflowRunsApi(id, params);
      if (!isMounted()) return;
      setRuns(response.items);
      setMeta(response.meta);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch workflow runs';
      setError(message);
      setRuns([]);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { runs, meta, isLoading, error, fetchRuns };
}
