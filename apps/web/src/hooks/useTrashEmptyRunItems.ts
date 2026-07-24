import { useState, useCallback } from 'react';
import type {
  TrashEmptyRunItem,
  TrashEmptyRunListMeta,
  TrashEmptyRunItemsQueryParams,
} from '../types/trashEmptyRuns';
import { listTrashEmptyRunItems as listTrashEmptyRunItemsApi } from '../services/trashEmptyRuns';

interface UseTrashEmptyRunItemsResult {
  items: TrashEmptyRunItem[];
  meta: TrashEmptyRunListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchItems: (runId: string, params?: TrashEmptyRunItemsQueryParams) => Promise<void>;
}

export function useTrashEmptyRunItems(): UseTrashEmptyRunItemsResult {
  const [items, setItems] = useState<TrashEmptyRunItem[]>([]);
  const [meta, setMeta] = useState<TrashEmptyRunListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(
    async (runId: string, params?: TrashEmptyRunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listTrashEmptyRunItemsApi(runId, params);
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch trash-empty run items';
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
