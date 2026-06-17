import { useState, useCallback, useEffect, useRef } from 'react';
import { getMediaFaces, getMediaFaceStatus, rerunMediaFaces } from '../services/face';
import type { DetectedFaceDto, MediaFaceStatusDto, MediaFaceStatusType } from '../services/face';

const TERMINAL_STATUSES: MediaFaceStatusType[] = ['processed', 'failed', 'no_faces'];
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

export function useMediaFaces(mediaId: string) {
  const [faces, setFaces] = useState<DetectedFaceDto[]>([]);
  const [status, setStatus] = useState<MediaFaceStatusDto | null>(null);
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
    setLoading(true);
    setError(null);
    try {
      const [facesData, statusData] = await Promise.all([
        getMediaFaces(mediaId),
        getMediaFaceStatus(mediaId),
      ]);
      setFaces(facesData);
      setStatus(statusData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load face data');
    } finally {
      setLoading(false);
    }
  }, [mediaId]);

  useEffect(() => {
    void loadData();
    return () => stopPolling();
  }, [loadData, stopPolling]);

  const rerun = useCallback(async () => {
    setRerunLoading(true);
    stopPolling();
    try {
      await rerunMediaFaces(mediaId);
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
            setStatus(s);
            if (TERMINAL_STATUSES.includes(s.status) || pollCountRef.current >= MAX_POLLS) {
              stopPolling();
              setRerunLoading(false);
              // Refresh faces after terminal status
              void getMediaFaces(mediaId)
                .then(setFaces)
                .catch(() => undefined);
            }
          })
          .catch(() => {
            stopPolling();
            setRerunLoading(false);
          });
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rerun face detection');
      setRerunLoading(false);
    }
  }, [mediaId, stopPolling]);

  return { faces, status, loading, error, rerun, rerunLoading };
}
