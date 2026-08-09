import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { getMemory } from '../services/memories';
import { useIsMounted } from './useIsMounted';
import type { MemoryDetail, MemoryMyState } from '../types/memories';

export interface UseMemoryResult {
  memory: MemoryDetail | null;
  isLoading: boolean;
  error: string | null;
  /** True when the API answered 404 — deleted, expired, or not accessible. */
  notFound: boolean;
  refresh: () => Promise<void>;
  /** Merge into the loaded memory's own state (optimistic favorite/hide). */
  patchMyState: (id: string, patch: Partial<MemoryDetail['myState']>) => void;
}

/**
 * Single memory detail (`GET /api/memories/:id`).
 *
 * `enabled` mirrors the list hooks: with `features.memories` off the route
 * still exists (a bookmark must not 404 the router), but the request is never
 * fired and the page renders its disabled state instead.
 *
 * A 404 is reported separately from a transport error because the two need
 * different copy: the API deliberately returns 404 — not 403 — for a memory in
 * a circle the caller does not belong to, and for one that was deleted or has
 * expired, so "not found" here is a normal outcome rather than a fault.
 */
export function useMemory(id: string | undefined, enabled = true): UseMemoryResult {
  const [memory, setMemory] = useState<MemoryDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    if (!id || !enabled) {
      setMemory(null);
      setError(null);
      setNotFound(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const result = await getMemory(id);
      if (!isMounted()) return;
      setMemory(result);
    } catch (err) {
      if (!isMounted()) return;
      setMemory(null);
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load this memory');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [id, enabled, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchMyState = useCallback(
    (targetId: string, patch: Partial<MemoryMyState & { hidden: boolean }>) => {
      setMemory((prev) =>
        prev && prev.id === targetId
          ? { ...prev, myState: { ...prev.myState, ...patch } }
          : prev,
      );
    },
    [],
  );

  return { memory, isLoading, error, notFound, refresh: load, patchMyState };
}
