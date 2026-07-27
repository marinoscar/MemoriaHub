import { useState, useCallback } from 'react';
import { listCircles, createCircle, deleteCircle, updateCircle } from '../services/circles';
import { useIsMounted } from './useIsMounted';
import type { Circle } from '../types/circles';

// Hook for managing circle list (admin pages, circle list page)
export function useCircles() {
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchCircles = useCallback(async (all?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listCircles(all);
      if (!isMounted()) return;
      setCircles(resp.items);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load circles');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted]);

  const addCircle = useCallback(async (dto: { name: string; description?: string }) => {
    const c = await createCircle(dto);
    if (isMounted()) setCircles((prev) => [...prev, c]);
    return c;
  }, [isMounted]);

  const editCircle = useCallback(
    async (id: string, dto: { name?: string; description?: string }) => {
      const c = await updateCircle(id, dto);
      if (isMounted()) setCircles((prev) => prev.map((x) => (x.id === id ? c : x)));
      return c;
    },
    [isMounted],
  );

  const removeCircle = useCallback(async (id: string) => {
    await deleteCircle(id);
    if (isMounted()) setCircles((prev) => prev.filter((x) => x.id !== id));
  }, [isMounted]);

  return { circles, loading, error, fetchCircles, addCircle, editCircle, removeCircle };
}
