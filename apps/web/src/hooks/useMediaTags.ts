import { useState, useCallback, useEffect, useRef } from 'react';
import { getMediaTagStatus, rerunMediaTags } from '../services/tagging';
import type { MediaTagStatusDto, MediaTagStatusType } from '../services/tagging';

const TERMINAL_STATUSES: MediaTagStatusType[] = ['processed', 'failed'];
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

export function useMediaTags(mediaId: string, onRefreshTags: () => void) {
  const [status, setStatus] = useState<MediaTagStatusDto | null>(null);
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
      const statusData = await getMediaTagStatus(mediaId);
      setStatus(statusData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tag status');
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
      await rerunMediaTags(mediaId);
      // Optimistically update status to pending
      setStatus((prev) =>
        prev
          ? { ...prev, status: 'pending' }
          : {
              status: 'pending',
              providerKey: null,
              modelVersion: null,
              tagCount: 0,
              processedAt: null,
              lastError: null,
            },
      );

      pollCountRef.current = 0;
      pollRef.current = setInterval(() => {
        pollCountRef.current += 1;
        getMediaTagStatus(mediaId)
          .then((s) => {
            setStatus(s);
            if (TERMINAL_STATUSES.includes(s.status) || pollCountRef.current >= MAX_POLLS) {
              stopPolling();
              setRerunLoading(false);
              // Refresh tags after terminal status
              onRefreshTags();
            }
          })
          .catch(() => {
            stopPolling();
            setRerunLoading(false);
          });
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rerun AI tagging');
      setRerunLoading(false);
    }
  }, [mediaId, stopPolling, onRefreshTags]);

  return { status, loading, error, rerun, rerunLoading };
}
