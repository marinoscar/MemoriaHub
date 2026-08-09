import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listMemories } from '../services/memories';
import { useIsMounted } from './useIsMounted';
import { useMemoryListState } from './useMemoryListState';
import type { MemoryListMutators } from './useMemoryListState';
import type { MemoryCard, MemoryListParams } from '../types/memories';

/** Filters the `/memories` hub exposes. Circle scope is supplied separately. */
export interface MemoryFilters {
  type?: MemoryListParams['type'];
  year?: number;
  favorite?: boolean;
}

export interface UseMemoriesResult
  extends Pick<
    MemoryListMutators<MemoryCard>,
    'patchMyState' | 'removeItem' | 'restoreItem'
  > {
  items: MemoryCard[];
  hasMore: boolean;
  isLoading: boolean;
  /** True only for the FIRST page of a query — drives the skeleton grid. */
  isInitialLoading: boolean;
  error: string | null;
  loadMore: () => void;
  /** Reset to the first page and refetch. */
  reset: () => void;
}

export const MEMORIES_PAGE_SIZE = 24;

/**
 * Cursor-paginated memory list (`GET /api/memories`) for the `/memories` hub.
 *
 * Modelled on `useInfiniteMedia`: a generation counter discards stale in-flight
 * pages after a filter change, the cursor lives in a ref so `loadMore` stays
 * referentially stable, and an in-flight guard keeps a fast scroll from firing
 * the same page twice.
 *
 * `enabled` is the feature gate. When false — the flag off, or no active circle
 * — the hook issues NO request at all and reports an empty, terminal list.
 */
export function useMemories(
  circleId: string | null,
  filters: MemoryFilters,
  enabled = true,
  pageSize = MEMORIES_PAGE_SIZE,
): UseMemoriesResult {
  const [items, setItems] = useState<MemoryCard[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cursorRef = useRef<string | null>(null);
  const inflightRef = useRef(false);
  const genRef = useRef(0);
  const isMounted = useIsMounted();
  const { patchMyState, removeItem, restoreItem, clearRemoved } =
    useMemoryListState<MemoryCard>(setItems);

  const active = enabled && circleId != null;

  // Serialized so an inline `{ type, year }` literal from the caller cannot
  // retrigger the reset effect on every render — only a genuine VALUE change.
  const queryKey = useMemo(
    () => JSON.stringify({ circleId, filters, pageSize, active }),
    [circleId, filters, pageSize, active],
  );

  const paramsRef = useRef({ circleId, filters, pageSize });
  paramsRef.current = { circleId, filters, pageSize };

  const fetchPage = useCallback(
    async (initial: boolean, gen: number) => {
      const { circleId: id, filters: f, pageSize: size } = paramsRef.current;
      if (!id) return;
      if (inflightRef.current) return;
      inflightRef.current = true;
      setIsLoading(true);
      if (initial) setIsInitialLoading(true);
      setError(null);
      try {
        const result = await listMemories({
          circleId: id,
          ...f,
          cursor: initial ? null : cursorRef.current,
          pageSize: size,
        });
        if (gen !== genRef.current || !isMounted()) return;
        setItems((prev) => (initial ? result.items : [...prev, ...result.items]));
        cursorRef.current = result.meta.nextCursor;
        setHasMore(result.meta.hasMore);
      } catch (err) {
        if (gen !== genRef.current || !isMounted()) return;
        setError(err instanceof Error ? err.message : 'Failed to load memories');
      } finally {
        if (gen === genRef.current) {
          inflightRef.current = false;
          if (isMounted()) {
            setIsLoading(false);
            setIsInitialLoading(false);
          }
        }
      }
    },
    [isMounted],
  );

  const restart = useCallback(() => {
    genRef.current += 1;
    inflightRef.current = false;
    const gen = genRef.current;
    cursorRef.current = null;
    clearRemoved();
    setItems([]);
    setHasMore(false);
    setError(null);
    setIsLoading(false);
    setIsInitialLoading(false);
    if (!paramsRef.current.circleId) return;
    void fetchPage(true, gen);
  }, [fetchPage, clearRemoved]);

  useEffect(() => {
    if (!active) {
      // Bump the generation so any page still in flight from the previous
      // query is discarded rather than landing in a list the caller disabled.
      genRef.current += 1;
      inflightRef.current = false;
      cursorRef.current = null;
      clearRemoved();
      setItems([]);
      setHasMore(false);
      setError(null);
      setIsLoading(false);
      setIsInitialLoading(false);
      return;
    }
    restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const loadMore = useCallback(() => {
    if (inflightRef.current) return;
    if (cursorRef.current == null) return;
    void fetchPage(false, genRef.current);
  }, [fetchPage]);

  return {
    items,
    hasMore: active ? hasMore : false,
    isLoading,
    isInitialLoading,
    error,
    loadMore,
    reset: restart,
    patchMyState,
    removeItem,
    restoreItem,
  };
}
