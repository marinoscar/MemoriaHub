import { useState, useCallback } from 'react';
import type {
  WorkflowRun,
  WorkflowListMeta,
  RunsQueryParams,
} from '../types/workflows';
import { listWorkflowRuns as listWorkflowRunsApi } from '../services/workflows';

interface UseWorkflowRunsResult {
  runs: WorkflowRun[];
  meta: WorkflowListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchRuns: (id: string, params?: RunsQueryParams) => Promise<void>;
}

export function useWorkflowRuns(): UseWorkflowRunsResult {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [meta, setMeta] = useState<WorkflowListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async (id: string, params?: RunsQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listWorkflowRunsApi(id, params);
      setRuns(response.items);
      setMeta(response.meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch workflow runs';
      setError(message);
      setRuns([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { runs, meta, isLoading, error, fetchRuns };
}
