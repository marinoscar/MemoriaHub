import { useState, useCallback } from 'react';
import type {
  WorkflowRunItem,
  WorkflowListMeta,
  RunItemsQueryParams,
} from '../types.js';
import { listWorkflowRunItems as listWorkflowRunItemsApi } from '../services/workflows.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * Use Workflow Run Items Result.
 *
 * @stability experimental
 */
export interface UseWorkflowRunItemsResult {
  /** The `items`. */
  items: WorkflowRunItem[];
  /** The `meta`. */
  meta: WorkflowListMeta | null;
  /** The `isLoading`. */
  isLoading: boolean;
  /** The `error`. */
  error: string | null;
  /** The `fetchItems`. */
  fetchItems: (runId: string, params?: RunItemsQueryParams) => Promise<void>;
}

/**
 * Use Workflow Run Items.
 *
 * @stability experimental
 */
export function useWorkflowRunItems(): UseWorkflowRunItemsResult {
  const [items, setItems] = useState<WorkflowRunItem[]>([]);
  const [meta, setMeta] = useState<WorkflowListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchItems = useCallback(
    async (runId: string, params?: RunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listWorkflowRunItemsApi(runId, params);
        if (!isMounted()) return;
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        if (!isMounted()) return;
        const message =
          err instanceof Error ? err.message : 'Failed to fetch workflow run items';
        setError(message);
        setItems([]);
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  return { items, meta, isLoading, error, fetchItems };
}
