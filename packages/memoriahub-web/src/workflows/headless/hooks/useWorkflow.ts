import { useState, useCallback } from 'react';
import type { Workflow } from '../types.js';
import { getWorkflow as getWorkflowApi } from '../services/workflows.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * Use Workflow Result.
 *
 * @stability experimental
 */
export interface UseWorkflowResult {
  /** The `workflow`. */
  workflow: Workflow | null;
  /** The `isLoading`. */
  isLoading: boolean;
  /** The `error`. */
  error: string | null;
  /** The `fetchWorkflow`. */
  fetchWorkflow: (id: string) => Promise<void>;
}

/**
 * Use Workflow.
 *
 * @stability experimental
 */
export function useWorkflow(): UseWorkflowResult {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchWorkflow = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getWorkflowApi(id);
      if (!isMounted()) return;
      setWorkflow(response);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch workflow';
      setError(message);
      setWorkflow(null);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { workflow, isLoading, error, fetchWorkflow };
}
