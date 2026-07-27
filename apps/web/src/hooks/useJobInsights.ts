import { useState, useEffect, useCallback } from 'react';
import { getJobInsights, type JobInsights } from '../services/jobInsights';
import { useIsMounted } from './useIsMounted';

export function useJobInsights(windowDays?: number) {
  const [data, setData] = useState<JobInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getJobInsights(windowDays);
      if (!isMounted()) return;
      setData(result);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load job insights');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [windowDays, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
