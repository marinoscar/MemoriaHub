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
 * Page fetcher contract. Given a 1-based page number and a page size, resolve
 * to that page's items plus the total page count so the hook can decide whether
 * more pages remain. This is the seam that lets MediaGallery back any surface
 * (Home, Trash, Archive, …) — not just `GET /api/media`.
 */
export type InfiniteMediaFetcher = (
  page: number,
  pageSize: number,
) => Promise<{ items: MediaItem[]; totalPages: number }>;

export interface UseInfiniteMediaOptions {
  /**
   * Optional custom page fetcher. When provided it is called instead of the
   * default `listMedia(params)`, so callers can pull from any paginated media
   * endpoint (e.g. `listTrash`, `listArchived`).
   */
  fetcher?: InfiniteMediaFetcher;
  /**
   * Reset/refetch key. When it changes the feed resets to page 1. Defaults to
   * `JSON.stringify(params)`. Supply this when using a custom `fetcher` whose
   * inputs are not captured by `params`.
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
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs to avoid stale closures
  const paramsRef = useRef(params);
  const pageSizeRef = useRef(pageSize);
  const fetcherRef = useRef<InfiniteMediaFetcher | undefined>(options?.fetcher);
  const inflightRef = useRef(false);
  // Generation counter: increments on reset so stale fetches are discarded
  const genRef = useRef(0);

  // Keep refs current
  paramsRef.current = params;
  pageSizeRef.current = pageSize;
  fetcherRef.current = options?.fetcher;

  // Serialized key for detecting param changes. A custom queryKey takes
  // precedence so callers with a fetcher can control reset semantics.
  const paramsKey = options?.queryKey ?? JSON.stringify(params);

  const fetchPage = useCallback(async (targetPage: number, gen: number) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const fetcher = fetcherRef.current;
      const response = fetcher
        ? await fetcher(targetPage, pageSizeRef.current)
        : await listMedia({
            ...paramsRef.current,
            page: targetPage,
            pageSize: pageSizeRef.current,
          }).then((r) => ({ items: r.items, totalPages: r.meta.totalPages }));
      if (gen !== genRef.current) return; // stale
      setItems((prev) =>
        targetPage === 1 ? response.items : [...prev, ...response.items],
      );
      setTotalPages(response.totalPages);
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
    setPage(1);
    setTotalPages(1);
    setError(null);
    setIsLoading(false);
    void fetchPage(1, gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, enabled, fetchPage]);

  const loadMore = useCallback(() => {
    if (inflightRef.current) return;
    setPage((prev) => {
      if (prev >= totalPages) return prev;
      const next = prev + 1;
      void fetchPage(next, genRef.current);
      return next;
    });
  }, [totalPages, fetchPage]);

  const reset = useCallback(() => {
    genRef.current += 1;
    inflightRef.current = false;
    const gen = genRef.current;
    setItems([]);
    setPage(1);
    setTotalPages(1);
    setError(null);
    setIsLoading(false);
    void fetchPage(1, gen);
  }, [fetchPage]);

  return {
    items,
    loadMore,
    hasMore: enabled ? page < totalPages : false,
    isLoading,
    error,
    reset,
  };
}
