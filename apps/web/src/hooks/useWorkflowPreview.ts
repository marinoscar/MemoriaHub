import { useState, useRef, useCallback } from 'react';
import type {
  WorkflowPreviewRequest,
  WorkflowPreviewResponse,
} from '../types/workflows';
import { previewWorkflow as previewWorkflowApi } from '../services/workflows';

interface UseWorkflowPreviewResult {
  preview: (body: WorkflowPreviewRequest) => Promise<WorkflowPreviewResponse | null>;
  data: WorkflowPreviewResponse | null;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

/**
 * Mutation hook for the live workflow preview. The CALLER is responsible for
 * debouncing — this hook does not debounce internally. Out-of-order responses
 * are guarded via a monotonic request id so only the latest request's result
 * is applied to state.
 */
export function useWorkflowPreview(): UseWorkflowPreviewResult {
  const [data, setData] = useState<WorkflowPreviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRequestId = useRef(0);

  const preview = useCallback(
    async (body: WorkflowPreviewRequest): Promise<WorkflowPreviewResponse | null> => {
      const requestId = ++latestRequestId.current;
      setIsLoading(true);
      setError(null);
      try {
        const response = await previewWorkflowApi(body);
        // Only apply if this is still the most recent request.
        if (requestId === latestRequestId.current) {
          setData(response);
          setIsLoading(false);
        }
        return response;
      } catch (err) {
        if (requestId === latestRequestId.current) {
          const message = err instanceof Error ? err.message : 'Failed to preview workflow';
          setError(message);
          setIsLoading(false);
        }
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    // Invalidate any in-flight request so its late response is ignored.
    latestRequestId.current++;
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return { preview, data, isLoading, error, reset };
}
