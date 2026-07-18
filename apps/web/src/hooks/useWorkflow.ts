import { useState, useCallback } from 'react';
import type { Workflow } from '../types/workflows';
import { getWorkflow as getWorkflowApi } from '../services/workflows';

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

  const fetchWorkflow = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getWorkflowApi(id);
      setWorkflow(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch workflow';
      setError(message);
      setWorkflow(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { workflow, isLoading, error, fetchWorkflow };
}
