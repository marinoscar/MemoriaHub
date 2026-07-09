import { useState, useCallback, useEffect, useRef } from 'react';
import {
  listUnassignedFaces,
  bulkHideFaces,
  bulkUnhideFaces,
  purgeFaces,
  purgeArchivedFaces,
} from '../services/face';
import type { UnassignedFaceDto } from '../services/face';

export function useUnassignedFaces(
  circleId: string | null,
  opts?: { archived?: boolean; pageSize?: number },
) {
  const archived = opts?.archived ?? false;
  const pageSize = opts?.pageSize ?? 50;
  const [faces, setFaces] = useState<UnassignedFaceDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef(1);

  const refresh = useCallback(async () => {
    if (!circleId) { setFaces([]); setTotal(0); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await listUnassignedFaces(circleId, { page: 1, pageSize, archived });
      pageRef.current = 1;
      setFaces(result.items);
      setTotal(result.meta.totalItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load unassigned faces');
    } finally {
      setLoading(false);
    }
  }, [circleId, archived, pageSize]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!circleId || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await listUnassignedFaces(circleId, {
        page: pageRef.current + 1,
        pageSize,
        archived,
      });
      pageRef.current += 1;
      setFaces((prev) => {
        const seen = new Set(prev.map((f) => f.faceId));
        return [...prev, ...result.items.filter((f) => !seen.has(f.faceId))];
      });
      setTotal(result.meta.totalItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more faces');
    } finally {
      setLoadingMore(false);
    }
  }, [circleId, archived, pageSize, loadingMore]);

  const hide = useCallback(
    async (ids: string[]) => {
      if (!circleId) return { hidden: 0 };
      return bulkHideFaces(circleId, ids);
    },
    [circleId],
  );

  const unhide = useCallback(
    async (ids: string[]) => {
      if (!circleId) return { unhidden: 0 };
      return bulkUnhideFaces(circleId, ids);
    },
    [circleId],
  );

  const purge = useCallback(
    async (ids: string[]) => {
      if (!circleId) return { deleted: 0 };
      return purgeFaces(circleId, ids);
    },
    [circleId],
  );

  const purgeArchived = useCallback(async () => {
    if (!circleId) return { deleted: 0 };
    return purgeArchivedFaces(circleId);
  }, [circleId]);

  const hasMore = faces.length < total;

  return {
    faces,
    total,
    hasMore,
    loadMore,
    loadingMore,
    loading,
    error,
    refresh,
    hide,
    unhide,
    purge,
    purgeArchived,
  };
}
