import { useState, useCallback, useEffect, useRef } from 'react';
import { getMediaMetadataStatus, rerunMediaMetadata } from '../services/metadata.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { MediaMetadataStatusDto, MediaMetadataStatusType } from '../services/metadata.js';

const TERMINAL_STATUSES: MediaMetadataStatusType[] = ['processed', 'failed'];
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

/**
 * What {@link useMediaMetadata} returns.
 *
 * @stability experimental
 */
export interface UseMediaMetadataResult {
  /** The latest status, `null` until it loads. */
  status: MediaMetadataStatusDto | null;
  /** True while the status loads. */
  loading: boolean;
  /** The failure message, `null` when none. */
  error: string | null;
  /** Enqueues a re-run and polls it to a terminal status. */
  rerun: () => Promise<void>;
  /** True while a re-run is in flight. */
  rerunLoading: boolean;
}

/**
 * The metadata-extraction status of one item and the action that re-runs it.
 *
 * @param mediaId - the item.
 * @param onRefresh - called when a re-run reached a terminal status, so the caller reloads the item.
 * @returns the status, the loading and error state, and `rerun`, which enqueues a re-run and polls it to a terminal status.
 *
 * @stability experimental
 */
export function useMediaMetadata(mediaId: string, onRefresh: () => void): UseMediaMetadataResult {
  const [status, setStatus] = useState<MediaMetadataStatusDto | null>(null);
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
      const statusData = await getMediaMetadataStatus(mediaId);
      if (!isMounted()) return;
      setStatus(statusData);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load metadata status');
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
      await rerunMediaMetadata(mediaId);
      if (!isMounted()) return;
      // Optimistically update status to pending
      setStatus((prev) =>
        prev
          ? { ...prev, status: 'pending' }
          : { status: 'pending', processedAt: null, lastError: null },
      );

      pollCountRef.current = 0;
      pollRef.current = setInterval(() => {
        pollCountRef.current += 1;
        getMediaMetadataStatus(mediaId)
          .then((s) => {
            if (!isMounted()) {
              stopPolling();
              return;
            }
            setStatus(s);
            if (TERMINAL_STATUSES.includes(s.status) || pollCountRef.current >= MAX_POLLS) {
              stopPolling();
              setRerunLoading(false);
              onRefresh();
            }
          })
          .catch(() => {
            stopPolling();
            if (isMounted()) setRerunLoading(false);
          });
      }, POLL_INTERVAL_MS);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to rerun metadata extraction');
      setRerunLoading(false);
    }
  }, [mediaId, stopPolling, onRefresh, isMounted]);

  return { status, loading, error, rerun, rerunLoading };
}
