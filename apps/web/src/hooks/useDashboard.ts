import { useState, useCallback, useEffect } from 'react';
import type { DashboardResponse } from '../types/media';
import { getDashboard } from '../services/media';
import { useCircle } from './useCircle';
import { useIsMounted } from './useIsMounted';

interface UseDashboardResult {
  data: DashboardResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useDashboard(): UseDashboardResult {
  const { activeCircleId } = useCircle();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetch = useCallback(async (circleId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getDashboard(circleId);
      if (!isMounted()) return;
      setData(response);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to load dashboard';
      setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (!activeCircleId) {
      setData(null);
      setIsLoading(false);
      return;
    }
    void fetch(activeCircleId);
  }, [activeCircleId, fetch]);

  const refetch = useCallback(() => {
    if (activeCircleId) {
      void fetch(activeCircleId);
    }
  }, [activeCircleId, fetch]);

  return { data, isLoading, error, refetch };
}
