import { useState, useCallback } from 'react';
import type { Workflow } from '../types/workflows';
import { getWorkflow as getWorkflowApi } from '../services/workflows';
import { useIsMounted } from './useIsMounted';

interface UseWorkflowResult {
  workflow: Workflow | null;
  isLoading: boolean;
  error: string | null;
  fetchWorkflow: (id: string) => Promise<void>;
}

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
