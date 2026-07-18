import { useState, useCallback } from 'react';
import type {
  WorkflowRunItem,
  WorkflowListMeta,
  RunItemsQueryParams,
} from '../types/workflows';
import { listWorkflowRunItems as listWorkflowRunItemsApi } from '../services/workflows';

interface UseWorkflowRunItemsResult {
  items: WorkflowRunItem[];
  meta: WorkflowListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchItems: (runId: string, params?: RunItemsQueryParams) => Promise<void>;
}

export function useWorkflowRunItems(): UseWorkflowRunItemsResult {
  const [items, setItems] = useState<WorkflowRunItem[]>([]);
  const [meta, setMeta] = useState<WorkflowListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(
    async (runId: string, params?: RunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listWorkflowRunItemsApi(runId, params);
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch workflow run items';
        setError(message);
        setItems([]);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { items, meta, isLoading, error, fetchItems };
}
