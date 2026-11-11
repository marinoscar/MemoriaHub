import { useState, useCallback, useEffect, useRef } from 'react';
import { getMediaTagStatus, rerunMediaTags } from '../services/tagging.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { MediaTagStatusDto, MediaTagStatusType } from '../services/tagging.js';

const TERMINAL_STATUSES: MediaTagStatusType[] = ['processed', 'failed'];
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

/**
 * The result of {@link useMediaTags}.
 *
 * @stability experimental
 */
export interface UseMediaTagsResult {
  /** The tagging status of the item, `null` before it loads. */
  status: MediaTagStatusDto | null;
  /** True while the status loads. */
  loading: boolean;
  /** The failure message, `null` when none. */
  error: string | null;
  /** Re-runs AI tagging and polls the status until it is terminal. */
  rerun: () => Promise<void>;
  /** True while a re-run is in flight. */
  rerunLoading: boolean;
}

/**
 * Use Media Tags.
 *
 * @stability experimental
 */
export function useMediaTags(mediaId: string, onRefreshTags: () => void): UseMediaTagsResult {
  const [status, setStatus] = useState<MediaTagStatusDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunLoading, setRerunLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const isMounted = useIsMounted();

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
      if (!isMounted()) return;
      setStatus(statusData);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load tag status');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [mediaId, isMounted]);

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
      if (!isMounted()) return;
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
            if (!isMounted()) {
              stopPolling();
              return;
            }
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
            if (isMounted()) setRerunLoading(false);
          });
      }, POLL_INTERVAL_MS);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to rerun AI tagging');
      setRerunLoading(false);
    }
  }, [mediaId, stopPolling, onRefreshTags, isMounted]);

  return { status, loading, error, rerun, rerunLoading };
}
