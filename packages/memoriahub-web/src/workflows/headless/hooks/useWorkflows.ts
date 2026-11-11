import { useState, useCallback } from 'react';
import type {
  Workflow,
  WorkflowListMeta,
  WorkflowsQueryParams,
} from '../types.js';
import { listWorkflows as listWorkflowsApi } from '../services/workflows.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * Use Workflows Result.
 *
 * @stability experimental
 */
export interface UseWorkflowsResult {
  /** The `workflows`. */
  workflows: Workflow[];
  /** The `meta`. */
  meta: WorkflowListMeta | null;
  /** The `isLoading`. */
  isLoading: boolean;
  /** The `error`. */
  error: string | null;
  /** The `fetchWorkflows`. */
  fetchWorkflows: (params: WorkflowsQueryParams) => Promise<void>;
}

/**
 * Use Workflows.
 *
 * @stability experimental
 */
export function useWorkflows(): UseWorkflowsResult {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [meta, setMeta] = useState<WorkflowListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchWorkflows = useCallback(async (params: WorkflowsQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listWorkflowsApi(params);
      if (!isMounted()) return;
      setWorkflows(response.items);
      setMeta(response.meta);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch workflows';
      setError(message);
      setWorkflows([]);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { workflows, meta, isLoading, error, fetchWorkflows };
}
