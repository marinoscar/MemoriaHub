import { useState, useCallback } from 'react';
import type {
  TrashEmptyRunItem,
  TrashEmptyRunListMeta,
  TrashEmptyRunItemsQueryParams,
} from '../types/trashEmptyRuns';
import { listTrashEmptyRunItems as listTrashEmptyRunItemsApi } from '../services/trashEmptyRuns';
import { useIsMounted } from './useIsMounted';

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
  const isMounted = useIsMounted();

  const fetchItems = useCallback(
    async (runId: string, params?: TrashEmptyRunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listTrashEmptyRunItemsApi(runId, params);
        if (!isMounted()) return;
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        if (!isMounted()) return;
        const message =
          err instanceof Error ? err.message : 'Failed to fetch trash-empty run items';
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
