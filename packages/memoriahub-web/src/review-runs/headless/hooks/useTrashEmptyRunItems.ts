import { useState, useCallback } from 'react';
import type {
  TrashEmptyRunItem,
  TrashEmptyRunListMeta,
  TrashEmptyRunItemsQueryParams,
} from '../../../media/headless/index.js';
import { listTrashEmptyRunItems as listTrashEmptyRunItemsApi } from '../../../media/headless/index.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * The state and loader {@link useTrashEmptyRunItems} returns.
 *
 * @stability experimental
 */
export interface UseTrashEmptyRunItemsResult {
  items: TrashEmptyRunItem[];
  meta: TrashEmptyRunListMeta | null;
  isLoading: boolean;
  error: string | null;
  /** Loads one page of the run's items. */
  fetchItems: (runId: string, params?: TrashEmptyRunItemsQueryParams) => Promise<void>;
}

/**
 * Loads one page of an empty-trash run's items on demand (the failed-items table).
 *
 * @stability experimental
 */
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
