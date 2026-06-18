import { useState, useCallback, useEffect } from 'react';
import { listUnassignedFaces } from '../services/face';
import type { UnassignedFaceDto } from '../services/face';

export function useUnassignedFaces(circleId: string | null) {
  const [faces, setFaces] = useState<UnassignedFaceDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!circleId) { setFaces([]); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await listUnassignedFaces(circleId, { pageSize: 50 });
      setFaces(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load unassigned faces');
    } finally {
      setLoading(false);
    }
  }, [circleId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { faces, loading, error, refresh };
}
