import { useState, useCallback } from 'react';
import type {
  LocationSuggestionRunItem,
  LocationSuggestionRunListMeta,
  LocationSuggestionRunItemsQueryParams,
} from '../types/locationSuggestionRuns';
import { listLocationSuggestionRunItems as listLocationSuggestionRunItemsApi } from '../services/locationSuggestionRuns';

interface UseLocationSuggestionRunItemsResult {
  items: LocationSuggestionRunItem[];
  meta: LocationSuggestionRunListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchItems: (
    runId: string,
    params?: LocationSuggestionRunItemsQueryParams,
  ) => Promise<void>;
}

export function useLocationSuggestionRunItems(): UseLocationSuggestionRunItemsResult {
  const [items, setItems] = useState<LocationSuggestionRunItem[]>([]);
  const [meta, setMeta] = useState<LocationSuggestionRunListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(
    async (runId: string, params?: LocationSuggestionRunItemsQueryParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await listLocationSuggestionRunItemsApi(runId, params);
        setItems(response.items);
        setMeta(response.meta);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to fetch location-suggestion run items';
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
