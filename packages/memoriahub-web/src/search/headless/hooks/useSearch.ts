import { useState, useCallback } from 'react';
import { getSearchFields, performSearch } from '../services/search.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { SearchField, SearchRequest, SearchResponse } from '../services/search.js';
import type { MediaItem, MediaListMeta } from '../../../media/headless/index.js';

/**
 * The result of {@link useDeterministicSearch}.
 *
 * @stability experimental
 */
export interface UseDeterministicSearchResult {
  /** The searchable field descriptors, once loaded. */
  fields: SearchField[];
  /** The items of the last search. */
  searchResults: MediaItem[];
  /** The pagination meta of the last search, `null` before one ran. */
  meta: MediaListMeta | null;
  /** True while the field descriptors load. */
  isLoadingFields: boolean;
  /** True while a search runs. */
  isSearching: boolean;
  /** The failure message of the last call, `null` when none. */
  error: string | null;
  /** Loads the field descriptors. */
  fetchFields: () => Promise<void>;
  /** Runs a deterministic search; rejects with the failure. */
  search: (body: SearchRequest) => Promise<SearchResponse>;
}

/**
 * Deterministic search state over `GET /api/search/fields` and `POST /api/search`.
 *
 * @returns the fields, the last results and the calls that load them.
 *
 * @stability experimental
 */
export function useDeterministicSearch(): UseDeterministicSearchResult {
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
