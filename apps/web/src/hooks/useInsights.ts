import { useState, useCallback, useEffect } from 'react';
import { getInsights, refreshInsights } from '../services/insights';
import type { InsightsSnapshot } from '../services/insights';

export interface UseInsightsResult {
  data: InsightsSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useInsights(): UseInsightsResult {
  const [data, setData] = useState<InsightsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await getInsights();
      setData(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load insights');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load on mount
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual refresh: POST returns the fresh snapshot directly — no second GET needed
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const snapshot = await refreshInsights();
      setData(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh insights');
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { data, loading, refreshing, error, load, refresh };
}
