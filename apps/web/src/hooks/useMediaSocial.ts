import { useState, useCallback, useEffect, useRef } from 'react';
import { getSocialStatus, rerunSocial } from '../services/social';
import type { SocialStatusDto, SocialStatusType } from '../services/social';

const TERMINAL_STATUSES: SocialStatusType[] = ['processed', 'failed'];
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

export function useMediaSocial(mediaId: string, onRefresh: () => void) {
  const [status, setStatus] = useState<SocialStatusDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunLoading, setRerunLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  const loadData = useCallback(async () => {
    if (!mediaId) return;
    setLoading(true);
    setError(null);
    try {
      const statusData = await getSocialStatus(mediaId);
      setStatus(statusData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load social detection status');
    } finally {
      setLoading(false);
    }
  }, [mediaId]);

  useEffect(() => {
    void loadData();
    return () => stopPolling();
  }, [loadData, stopPolling]);

  const rerun = useCallback(async () => {
    if (!mediaId) return;
    setRerunLoading(true);
    stopPolling();
    try {
      await rerunSocial(mediaId);
      // Optimistically update status to pending
      setStatus({
        status: 'pending',
        detected: false,
        platform: null,
        processedAt: null,
        lastError: null,
      });

      pollCountRef.current = 0;
      pollRef.current = setInterval(() => {
        pollCountRef.current += 1;
        getSocialStatus(mediaId)
          .then((s) => {
            setStatus(s);
            if (TERMINAL_STATUSES.includes(s.status) || pollCountRef.current >= MAX_POLLS) {
              stopPolling();
              setRerunLoading(false);
              // Refresh media item after terminal status (tags may have changed)
              onRefresh();
            }
          })
          .catch(() => {
            stopPolling();
            setRerunLoading(false);
          });
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rerun social detection');
      setRerunLoading(false);
    }
  }, [mediaId, stopPolling, onRefresh]);

  return { status, loading, error, rerun, rerunLoading };
}
