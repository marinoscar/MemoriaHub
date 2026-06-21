import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaItem } from '../types/media';
import { listTrash } from '../services/media';

interface UseInfiniteTrashResult {
  items: MediaItem[];
  loadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

export function useInfiniteTrash(
  circleId: string,
  pageSize = 50,
  enabled = true,
): UseInfiniteTrashResult {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const circleIdRef = useRef(circleId);
  const pageSizeRef = useRef(pageSize);
  const inflightRef = useRef(false);
  const genRef = useRef(0);

  circleIdRef.current = circleId;
  pageSizeRef.current = pageSize;

  const fetchPage = useCallback(async (targetPage: number, gen: number) => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const response = await listTrash({
        circleId: circleIdRef.current,
        page: targetPage,
        pageSize: pageSizeRef.current,
      });
      if (gen !== genRef.current) return;
      setItems((prev) =>
        targetPage === 1 ? response.items : [...prev, ...response.items],
      );
      setTotalPages(response.meta.totalPages);
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load trash');
    } finally {
      if (gen === genRef.current) {
        inflightRef.current = false;
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled || !circleId) return;
    genRef.current += 1;
    inflightRef.current = false;
    const gen = genRef.current;
    setItems([]);
    setPage(1);
    setTotalPages(1);
    setError(null);
    setIsLoading(false);
    void fetchPage(1, gen);
  }, [circleId, enabled, fetchPage]); // eslint-disable-line react-hooks/exhaustive-deps

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
