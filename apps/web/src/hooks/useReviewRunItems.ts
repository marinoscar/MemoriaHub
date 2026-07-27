import { useState, useCallback } from 'react';
import type {
  ReviewRunItem,
  ReviewRunItemsQueryParams,
  ReviewRunListMeta,
} from '../types/reviewRuns';
import { listReviewRunItems as listReviewRunItemsApi } from '../services/reviewRuns';
import { useIsMounted } from './useIsMounted';

interface UseReviewRunItemsResult {
  items: ReviewRunItem[];
  meta: ReviewRunListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchItems: (runId: string, params?: ReviewRunItemsQueryParams) => Promise<void>;
}

export function useReviewRunItems(): UseReviewRunItemsResult {
  const [items, setItems] = useState<ReviewRunItem[]>([]);
  const [meta, setMeta] = useState<ReviewRunListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchItems = useCallback(
    async (runId: string, params?: ReviewRunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listReviewRunItemsApi(runId, params);
        if (!isMounted()) return;
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        if (!isMounted()) return;
        const message =
          err instanceof Error ? err.message : 'Failed to fetch review run items';
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
