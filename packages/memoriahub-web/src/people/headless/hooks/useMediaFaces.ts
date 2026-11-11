import { useState, useCallback, useEffect, useRef } from 'react';
import { getMediaFaces, getMediaFaceStatus, rerunMediaFaces } from '../services/people.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { DetectedFaceDto, MediaFaceStatusDto, MediaFaceStatusType } from '../services/people.js';

const TERMINAL_STATUSES: MediaFaceStatusType[] = ['processed', 'failed', 'no_faces'];
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

/**
 * Loads the faces and detection status of a media item and polls a running detection to a terminal status.
 *
 * @param mediaId - the media item.
 * @returns the faces, the status and the re-run.
 *
 * @stability experimental
 */
export function useMediaFaces(mediaId: string) {
  const [faces, setFaces] = useState<DetectedFaceDto[]>([]);
  const [status, setStatus] = useState<MediaFaceStatusDto | null>(null);
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
      const [facesData, statusData] = await Promise.all([
        getMediaFaces(mediaId),
        getMediaFaceStatus(mediaId),
      ]);
      if (!isMounted()) return;
      setFaces(facesData);
      setStatus(statusData);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load face data');
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
      await rerunMediaFaces(mediaId);
      if (!isMounted()) return;
      // Optimistically update status to pending
      setStatus((prev) =>
        prev
          ? { ...prev, status: 'pending' }
          : {
              status: 'pending',
              faceCount: 0,
              providerKey: null,
              modelVersion: null,
              processedAt: null,
              lastError: null,
            },
      );

      pollCountRef.current = 0;
      pollRef.current = setInterval(() => {
        pollCountRef.current += 1;
        getMediaFaceStatus(mediaId)
          .then((s) => {
            if (!isMounted()) {
              stopPolling();
              return;
            }
            setStatus(s);
            if (TERMINAL_STATUSES.includes(s.status) || pollCountRef.current >= MAX_POLLS) {
              stopPolling();
              setRerunLoading(false);
              // Refresh faces after terminal status
              void getMediaFaces(mediaId)
                .then((f) => {
                  if (isMounted()) setFaces(f);
                })
                .catch(() => undefined);
            }
          })
          .catch(() => {
            stopPolling();
            if (isMounted()) setRerunLoading(false);
          });
      }, POLL_INTERVAL_MS);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to rerun face detection');
      setRerunLoading(false);
    }
  }, [mediaId, stopPolling, isMounted]);

  return {
    faces,
    status,
    loading,
    error,
    /** Re-runs face detection and polls the status until it is terminal. */
    rerun,
    rerunLoading,
    /** Reloads the faces and the status. */
    refresh: loadData,
  };
}
