import { useState, useCallback } from 'react';
import type {
  ReviewRunItem,
  ReviewRunItemsQueryParams,
  ReviewRunListMeta,
} from '../types/reviewRuns';
import { listReviewRunItems as listReviewRunItemsApi } from '../services/reviewRuns';

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

  const fetchItems = useCallback(
    async (runId: string, params?: ReviewRunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listReviewRunItemsApi(runId, params);
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch review run items';
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
