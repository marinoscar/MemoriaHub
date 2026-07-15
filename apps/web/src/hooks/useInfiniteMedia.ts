import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaItem, MediaQueryParams } from '../types/media';
import { listMedia } from '../services/media';

interface UseInfiniteMediaResult {
  items: MediaItem[];
  loadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

/**
 * Cursor (keyset) fetcher contract. Given an opaque cursor (`null` for the
 * first page) and a page size, resolve to that page's items plus the cursor
 * for the NEXT page (`null` when no more pages remain). This is the seam that
 * lets MediaGallery back any surface (Home, Trash, Archive, …).
 *
 * `GET /api/media` is natively keyset. Endpoints still on offset pagination
 * (Search, Trash, Archive) adapt to this contract by encoding the page number
 * as the cursor string — see those pages' fetcher lambdas.
 */
export type InfiniteMediaFetcher = (
  cursor: string | null,
  pageSize: number,
) => Promise<{ items: MediaItem[]; nextCursor: string | null }>;

export interface UseInfiniteMediaOptions {
  /**
   * Optional custom page fetcher. When provided it is called instead of the
   * default `listMedia(params)`, so callers can pull from any paginated media
   * endpoint (e.g. `listTrash`, `listArchived`).
   */
  fetcher?: InfiniteMediaFetcher;
  /**
   * Reset/refetch key. When it changes the feed resets to the first page.
   * Defaults to `JSON.stringify(params)`. Supply this when using a custom
   * `fetcher` whose inputs are not captured by `params`.
   */
  queryKey?: string;
}

export function useInfiniteMedia(
  params: Omit<MediaQueryParams, 'page' | 'pageSize'>,
  pageSize = 50,
  enabled = true,
  options?: UseInfiniteMediaOptions,
): UseInfiniteMediaResult {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs to avoid stale closures
  const paramsRef = useRef(params);
  const pageSizeRef = useRef(pageSize);
  const fetcherRef = useRef<InfiniteMediaFetcher | undefined>(options?.fetcher);
  const inflightRef = useRef(false);
  // Cursor for the NEXT page to load. null means "start from the first page".
  const cursorRef = useRef<string | null>(null);
  // Generation counter: increments on reset so stale fetches are discarded
  const genRef = useRef(0);

  // Keep refs current
  paramsRef.current = params;
  pageSizeRef.current = pageSize;
  fetcherRef.current = options?.fetcher;

  // Serialized key for detecting param changes. A custom queryKey takes
  // precedence so callers with a fetcher can control reset semantics.
  const paramsKey = options?.queryKey ?? JSON.stringify(params);

  /**
   * Fetch one page. `initial=true` replaces the item list (first load / reset);
   * `initial=false` appends (loadMore). The cursor to fetch is read from
   * `cursorRef`, which is `null` for the initial load.
   */
  const fetchPage = useCallback(async (initial: boolean, gen: number) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const cursor = initial ? null : cursorRef.current;
      const fetcher = fetcherRef.current;
      const response = fetcher
        ? await fetcher(cursor, pageSizeRef.current)
        : await listMedia({
            ...paramsRef.current,
            cursor,
            pageSize: pageSizeRef.current,
          }).then((r) => ({ items: r.items, nextCursor: r.meta.nextCursor }));
      if (gen !== genRef.current) return; // stale
      setItems((prev) => (initial ? response.items : [...prev, ...response.items]));
      cursorRef.current = response.nextCursor;
      setHasMore(response.nextCursor != null);
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load media');
    } finally {
      if (gen === genRef.current) {
        inflightRef.current = false;
        setIsLoading(false);
      }
    }
  }, []); // stable — uses refs

  // Reset and refetch whenever params change or enabled toggles
  useEffect(() => {
    if (!enabled) return;
    genRef.current += 1;
    inflightRef.current = false;
    const gen = genRef.current;
    setItems([]);
    cursorRef.current = null;
    setHasMore(false);
    setError(null);
    setIsLoading(false);
    void fetchPage(true, gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, enabled, fetchPage]);

  const loadMore = useCallback(() => {
    if (inflightRef.current) return;
    if (cursorRef.current == null) return; // no more pages
    void fetchPage(false, genRef.current);
  }, [fetchPage]);

  const reset = useCallback(() => {
    genRef.current += 1;
    inflightRef.current = false;
    const gen = genRef.current;
    setItems([]);
    cursorRef.current = null;
    setHasMore(false);
    setError(null);
    setIsLoading(false);
    void fetchPage(true, gen);
  }, [fetchPage]);

  return {
    items,
    loadMore,
    hasMore: enabled ? hasMore : false,
    isLoading,
    error,
    reset,
  };
}
