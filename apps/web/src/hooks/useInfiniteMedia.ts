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

export function useInfiniteMedia(
  params: Omit<MediaQueryParams, 'page' | 'pageSize'>,
  pageSize = 50,
  enabled = true,
): UseInfiniteMediaResult {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs to avoid stale closures
  const paramsRef = useRef(params);
  const pageSizeRef = useRef(pageSize);
  const inflightRef = useRef(false);
  // Generation counter: increments on reset so stale fetches are discarded
  const genRef = useRef(0);

  // Keep refs current
  paramsRef.current = params;
  pageSizeRef.current = pageSize;

  // Serialized key for detecting param changes
  const paramsKey = JSON.stringify(params);

  const fetchPage = useCallback(async (targetPage: number, gen: number) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const response = await listMedia({
        ...paramsRef.current,
        page: targetPage,
        pageSize: pageSizeRef.current,
      });
      if (gen !== genRef.current) return; // stale
      setItems((prev) =>
        targetPage === 1 ? response.items : [...prev, ...response.items],
      );
      setTotalPages(response.meta.totalPages);
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
