import { useState, useCallback, useEffect } from 'react';
import {
  listPeople,
  getPerson,
  createPerson,
  updatePerson,
  assignFaces,
  unassignFace,
  clusterUnknownFaces,
} from '../services/face';
import type { PersonListResponse, PersonDetail, ClusterResult } from '../services/face';

// Hook for listing people in a circle
export function usePeople(circleId: string | null, opts?: { includeUnlabeled?: boolean }) {
  const [data, setData] = useState<PersonListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listPeople(circleId, {
        includeUnlabeled: opts?.includeUnlabeled,
        pageSize: 100,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load people');
    } finally {
      setLoading(false);
    }
  }, [circleId, opts?.includeUnlabeled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (body: { name?: string; faceIds?: string[] }) => {
      if (!circleId) throw new Error('No active circle');
      const result = await createPerson({ circleId, ...body });
      await refresh();
      return result;
    },
    [circleId, refresh],
  );

  const rename = useCallback(
    async (personId: string, name: string) => {
      await updatePerson(personId, { name });
      await refresh();
    },
    [refresh],
  );

  const cluster = useCallback(async (): Promise<ClusterResult> => {
    if (!circleId) throw new Error('No active circle');
    const result = await clusterUnknownFaces(circleId);
    await refresh();
    return result;
  }, [circleId, refresh]);

  const doAssignFaces = useCallback(
    async (personId: string, faceIds: string[]) => {
      await assignFaces(personId, faceIds);
      await refresh();
    },
    [refresh],
  );

  const doUnassignFace = useCallback(
    async (personId: string, faceId: string) => {
      await unassignFace(personId, faceId);
      await refresh();
    },
    [refresh],
  );

  return {
    data,
    loading,
    error,
    refresh,
    create,
    rename,
    cluster,
    assignFaces: doAssignFaces,
    unassignFace: doUnassignFace,
  };
}

// Hook for a single person's detail
export function usePerson(personId: string | null) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!personId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getPerson(personId);
      setPerson(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load person');
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { person, loading, error, refresh };
}
