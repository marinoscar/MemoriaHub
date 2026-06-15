import { useState, useCallback } from 'react';
import { getSearchFields, performSearch } from '../services/search';
import type { SearchField, SearchRequest, SearchResponse } from '../services/search';
import type { MediaItem, MediaListMeta } from '../types/media';

export function useSearch() {
  const [fields, setFields] = useState<SearchField[]>([]);
  const [searchResults, setSearchResults] = useState<MediaItem[]>([]);
  const [meta, setMeta] = useState<MediaListMeta | null>(null);
  const [isLoadingFields, setIsLoadingFields] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFields = useCallback(async () => {
    setIsLoadingFields(true);
    setError(null);
    try {
      const data = await getSearchFields();
      setFields(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load search fields');
    } finally {
      setIsLoadingFields(false);
    }
  }, []);

  const search = useCallback(async (body: SearchRequest): Promise<SearchResponse> => {
    setIsSearching(true);
    setError(null);
    try {
      const result = await performSearch(body);
      setSearchResults(result.items);
      setMeta(result.meta);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      setError(message);
      throw err;
    } finally {
      setIsSearching(false);
    }
  }, []);

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
