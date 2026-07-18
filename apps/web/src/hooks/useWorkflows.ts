import { useState, useCallback } from 'react';
import type {
  Workflow,
  WorkflowListMeta,
  WorkflowsQueryParams,
} from '../types/workflows';
import { listWorkflows as listWorkflowsApi } from '../services/workflows';

interface UseWorkflowsResult {
  workflows: Workflow[];
  meta: WorkflowListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchWorkflows: (params: WorkflowsQueryParams) => Promise<void>;
}

export function useWorkflows(): UseWorkflowsResult {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [meta, setMeta] = useState<WorkflowListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkflows = useCallback(async (params: WorkflowsQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listWorkflowsApi(params);
      setWorkflows(response.items);
      setMeta(response.meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch workflows';
      setError(message);
      setWorkflows([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { workflows, meta, isLoading, error, fetchWorkflows };
}
