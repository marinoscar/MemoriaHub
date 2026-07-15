import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startEnhance,
  getEnhancement,
  getLatestEnhancement,
  applyEnhancement,
  discardEnhancement,
} from '../services/enhance';
import type {
  EnhanceParams,
  EnhancementDto,
  EnhancementStatus,
  ApplyDecision,
  ApplyEnhancementResult,
} from '../services/enhance';

// Poll every 2s (matches useMediaMetadata) until the job reaches a terminal
// state. Image generation can legitimately take 10–60s, so allow a generous
// window before giving up.
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 120; // 120 * 2s = 4 min ceiling
const TERMINAL_STATUSES: EnhancementStatus[] = ['ready', 'failed'];

export type EnhanceUiStatus = EnhancementStatus | 'idle';

/**
 * Drives the enhance → poll → review lifecycle for a single media item.
 * Mirrors useMediaMetadata's polling model (2s interval, capped).
 */
export function useMediaEnhance(mediaId: string) {
  const [data, setData] = useState<EnhancementDto | null>(null);
  const [status, setStatus] = useState<EnhanceUiStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const idRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  // Clean up on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const beginPolling = useCallback(
    (enhancementId: string) => {
      stopPolling();
      pollCountRef.current = 0;
      pollRef.current = setInterval(() => {
        pollCountRef.current += 1;
        getEnhancement(mediaId, enhancementId)
          .then((d) => {
            setData(d);
            setStatus(d.status);
            if (TERMINAL_STATUSES.includes(d.status)) {
              stopPolling();
              if (d.status === 'failed') {
                setError(d.lastError ?? 'Enhancement failed');
              }
            } else if (pollCountRef.current >= MAX_POLLS) {
              stopPolling();
              setError('Timed out waiting for the enhancement to finish.');
            }
          })
          .catch((err) => {
            stopPolling();
            setError(err instanceof Error ? err.message : 'Failed to poll enhancement');
          });
      }, POLL_INTERVAL_MS);
    },
    [mediaId, stopPolling],
  );

  /** Kick off a new enhancement and start polling. */
  const start = useCallback(
    async (params: EnhanceParams = {}) => {
      setError(null);
      setData(null);
      setStatus('pending');
      stopPolling();
      try {
        const res = await startEnhance(mediaId, params);
        idRef.current = res.enhancementId;
        beginPolling(res.enhancementId);
      } catch (err) {
        setStatus('idle');
        setError(err instanceof Error ? err.message : 'Failed to start enhancement');
      }
    },
    [mediaId, beginPolling, stopPolling],
  );

  /**
   * Load the latest existing enhancement (used to resume a review after a
   * reload). If it is still in-flight, resume polling; otherwise surface it.
   */
  const resumeLatest = useCallback(async () => {
    try {
      const latest = await getLatestEnhancement(mediaId);
      if (!latest) return;
      // Only resume enhancements that are still actionable in the drawer.
      if (['pending', 'processing', 'ready', 'failed'].includes(latest.status)) {
        idRef.current = latest.id;
        setData(latest);
        setStatus(latest.status);
        if (latest.status === 'failed') setError(latest.lastError ?? 'Enhancement failed');
        if (latest.status === 'pending' || latest.status === 'processing') {
          beginPolling(latest.id);
        }
      }
    } catch {
      // Non-fatal — the drawer simply starts from the params step.
    }
  }, [mediaId, beginPolling]);

  /** Commit the current enhancement (keep_both / replace). */
  const apply = useCallback(
    async (decision: ApplyDecision): Promise<ApplyEnhancementResult> => {
      if (!idRef.current) {
        throw new Error('No enhancement to apply');
      }
      return applyEnhancement(mediaId, idRef.current, decision);
    },
    [mediaId],
  );

  /** Discard the staging preview. */
  const discard = useCallback(async () => {
    if (!idRef.current) return;
    await discardEnhancement(mediaId, idRef.current);
  }, [mediaId]);

  /** Reset everything back to the params step. */
  const reset = useCallback(() => {
    stopPolling();
    idRef.current = null;
    setData(null);
    setStatus('idle');
    setError(null);
  }, [stopPolling]);

  const polling = status === 'pending' || status === 'processing';

  return { status, data, error, polling, start, resumeLatest, apply, discard, reset };
}
