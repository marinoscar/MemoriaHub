import { useState, useCallback, useEffect, useRef } from 'react';
import { getInsights, refreshInsights } from '../services/insights';
import type { InsightsSnapshot, InsightsRefreshState } from '../services/insights';

// Poll every 2.5 s while a job is pending/running
const POLL_INTERVAL_MS = 2500;
// Stop polling automatically after 2 minutes as a safety guard
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

export interface UseInsightsResult {
  data: InsightsSnapshot | null;
  loading: boolean;
  /** True while a refresh job is pending/running OR we are actively polling. */
  refreshing: boolean;
  /** Derived from data.refresh.state — 'idle' when no data yet. */
  jobState: InsightsRefreshState;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useInsights(): UseInsightsResult {
  const [data, setData] = useState<InsightsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs for the polling cleanup / timeout
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Clear any running poll interval and safety timeout. */
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current !== null) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  /**
   * Start (or restart) the poll loop. Each tick calls GET /admin/insights
   * and updates data. Stops when state is 'idle' or 'failed', or after the
   * safety timeout.
   */
  const startPolling = useCallback(() => {
    // Avoid stacking multiple intervals
    stopPolling();

    setRefreshing(true);

    const tick = async () => {
      try {
        const snapshot = await getInsights();
        setData(snapshot);

        if (snapshot.refresh.state === 'idle' || snapshot.refresh.state === 'failed') {
          stopPolling();
          setRefreshing(false);

          // Surface last error from the job into the error banner
          if (
            snapshot.refresh.state === 'failed' &&
            snapshot.refresh.lastError
          ) {
            setError(snapshot.refresh.lastError);
          }
        }
      } catch (err) {
        // On network error, stop polling and surface the message
        stopPolling();
        setRefreshing(false);
        setError(err instanceof Error ? err.message : 'Failed to poll insights');
      }
    };

    pollIntervalRef.current = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    // Safety timeout — give up after POLL_TIMEOUT_MS regardless
    pollTimeoutRef.current = setTimeout(() => {
      stopPolling();
      setRefreshing(false);
      setError('Refresh timed out — the job may still be running in the background.');
    }, POLL_TIMEOUT_MS);
  }, [stopPolling]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  // Initial load — fetch once, then auto-start polling if a job is already in flight
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await getInsights();
      setData(snapshot);

      // A scheduled or manual job was already running when the page opened
      if (
        snapshot.refresh.state === 'pending' ||
        snapshot.refresh.state === 'running'
      ) {
        startPolling();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load insights');
    } finally {
      setLoading(false);
    }
  }, [startPolling]);

  // Run load once on mount
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Manual "Refresh now" handler:
   *   1. POST to enqueue the job (returns immediately)
   *   2. Start polling until the job completes
   */
  const refresh = useCallback(async () => {
    setError(null);
    try {
      await refreshInsights();
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start refresh');
    }
  }, [startPolling]);

  const jobState: InsightsRefreshState = data?.refresh.state ?? 'idle';

  return { data, loading, refreshing, jobState, error, load, refresh };
}
