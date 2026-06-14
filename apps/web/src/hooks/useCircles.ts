import { useState, useCallback } from 'react';
import { listCircles, createCircle, deleteCircle, updateCircle } from '../services/circles';
import type { Circle } from '../types/circles';

// Hook for managing circle list (admin pages, circle list page)
export function useCircles() {
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCircles = useCallback(async (all?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listCircles(all);
      setCircles(resp.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load circles');
    } finally {
      setLoading(false);
    }
  }, []);

  const addCircle = useCallback(async (dto: { name: string; description?: string }) => {
    const c = await createCircle(dto);
    setCircles((prev) => [...prev, c]);
    return c;
  }, []);

  const editCircle = useCallback(
    async (id: string, dto: { name?: string; description?: string }) => {
      const c = await updateCircle(id, dto);
      setCircles((prev) => prev.map((x) => (x.id === id ? c : x)));
      return c;
    },
    [],
  );

  const removeCircle = useCallback(async (id: string) => {
    await deleteCircle(id);
    setCircles((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return { circles, loading, error, fetchCircles, addCircle, editCircle, removeCircle };
}
