import { useState, useEffect, useCallback } from 'react';
import { getJobInsights, type JobInsights } from '../services/jobInsights';

export function useJobInsights(windowDays?: number) {
  const [data, setData] = useState<JobInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getJobInsights(windowDays);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job insights');
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
