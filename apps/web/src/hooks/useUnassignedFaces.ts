import { useState, useCallback, useEffect } from 'react';
import {
  listUnassignedFaces,
  bulkHideFaces,
  bulkUnhideFaces,
  purgeFaces,
} from '../services/face';
import type { UnassignedFaceDto } from '../services/face';

export function useUnassignedFaces(
  circleId: string | null,
  opts?: { archived?: boolean },
) {
  const archived = opts?.archived ?? false;
  const [faces, setFaces] = useState<UnassignedFaceDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!circleId) { setFaces([]); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await listUnassignedFaces(circleId, { pageSize: 50, archived });
      setFaces(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load unassigned faces');
    } finally {
      setLoading(false);
    }
  }, [circleId, archived]);

  useEffect(() => { void refresh(); }, [refresh]);

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

  return { faces, loading, error, refresh, hide, unhide, purge };
}
