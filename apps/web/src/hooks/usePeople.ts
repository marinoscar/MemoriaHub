import { useState, useCallback, useEffect } from 'react';
import {
  listPeople,
  getPerson,
  createPerson,
  updatePerson,
  assignFaces,
  unassignFace,
  clusterUnknownFaces,
  bulkHidePeople,
  bulkUnhidePeople,
  purgePeople,
} from '../services/face';
import { useIsMounted } from './useIsMounted';
import type { PersonListResponse, PersonDetail, ClusterResult } from '../services/face';

// Hook for listing people in a circle
export function usePeople(
  circleId: string | null,
  opts?: {
    includeUnlabeled?: boolean;
    hidden?: boolean;
    /**
     * Page size for the underlying list request (default 100). Callers that
     * only need `data.meta.totalItems` (e.g. a count probe) can pass 1 so the
     * request doesn't ship a page of person records — and their signed cover
     * thumbnail URLs — that nothing renders.
     */
    pageSize?: number;
  },
) {
  const [data, setData] = useState<PersonListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!circleId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listPeople(circleId, {
        includeUnlabeled: opts?.includeUnlabeled,
        hidden: opts?.hidden,
        pageSize: opts?.pageSize ?? 100,
      });
      if (!isMounted()) return;
      setData(result);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load people');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [circleId, opts?.includeUnlabeled, opts?.hidden, opts?.pageSize, isMounted]);

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

  const hide = useCallback(
    async (ids: string[]) => {
      if (!circleId) throw new Error('No active circle');
      const result = await bulkHidePeople(circleId, ids);
      await refresh();
      return result;
    },
    [circleId, refresh],
  );

  const unhide = useCallback(
    async (ids: string[]) => {
      if (!circleId) throw new Error('No active circle');
      const result = await bulkUnhidePeople(circleId, ids);
      await refresh();
      return result;
    },
    [circleId, refresh],
  );

  const purge = useCallback(
    async (ids: string[]) => {
      if (!circleId) throw new Error('No active circle');
      const result = await purgePeople(circleId, ids);
      await refresh();
      return result;
    },
    [circleId, refresh],
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
    hide,
    unhide,
    purge,
  };
}

// Hook for a single person's detail
export function usePerson(personId: string | null) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!personId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getPerson(personId);
      if (!isMounted()) return;
      setPerson(result);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load person');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [personId, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { person, loading, error, refresh };
}
