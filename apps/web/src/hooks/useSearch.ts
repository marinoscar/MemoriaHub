import { useState, useCallback } from 'react';
import { getSearchFields, performSearch } from '../services/search';
import { useIsMounted } from './useIsMounted';
import type { SearchField, SearchRequest, SearchResponse } from '../services/search';
import type { MediaItem, MediaListMeta } from '../types/media';

export function useSearch() {
  const [fields, setFields] = useState<SearchField[]>([]);
  const [searchResults, setSearchResults] = useState<MediaItem[]>([]);
  const [meta, setMeta] = useState<MediaListMeta | null>(null);
  const [isLoadingFields, setIsLoadingFields] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchFields = useCallback(async () => {
    setIsLoadingFields(true);
    setError(null);
    try {
      const data = await getSearchFields();
      if (!isMounted()) return;
      setFields(data);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load search fields');
    } finally {
      if (isMounted()) setIsLoadingFields(false);
    }
  }, [isMounted]);

  const search = useCallback(async (body: SearchRequest): Promise<SearchResponse> => {
    setIsSearching(true);
    setError(null);
    try {
      const result = await performSearch(body);
      if (isMounted()) {
        setSearchResults(result.items);
        setMeta(result.meta);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      if (isMounted()) setError(message);
      throw err;
    } finally {
      if (isMounted()) setIsSearching(false);
    }
  }, [isMounted]);

  return {
    fields,
    searchResults,
    meta,
    isLoadingFields,
    isSearching,
    error,
    fetchFields,
    search,
  };
}
