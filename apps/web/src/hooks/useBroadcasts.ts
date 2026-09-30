/**
 * The broadcast list, its polling, and the writes. Epic #481, issue #488
 * (ported from the reference implementation).
 *
 * Every function RESOLVES rather than throws, and a failure is a STRING the
 * page renders: every caller is a click handler that needs to branch.
 *
 * POLLING IS OFF UNLESS SOMETHING IS IN FLIGHT. A broadcast list is usually at
 * rest — `sent`, `canceled` and `failed` rows cannot change on their own — so
 * the page passes `0` to `useVisiblePolling` unless a row is `scheduled` or
 * `sending`. A poll never raises the loading flag, so the table keeps its
 * scroll position while an operator watches a send progress.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcasts,
  resumeBroadcast,
  sendTestBroadcast,
} from '../services/broadcasts';
import type {
  Broadcast,
  BroadcastListParams,
  BroadcastTestResult,
  CreateBroadcastRequest,
} from '../services/broadcasts';
import { useIsMounted } from './useIsMounted';

/** How often the page re-reads the list while a row is scheduled or sending. */
export const BROADCASTS_POLL_INTERVAL_MS = 10_000;

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage broadcasts';
    // 409 is this surface's characteristic refusal (a cancel that lost the race
    // with the fan-out, a delete of something sending); the API says which.
    return err.message || fallback;
  }
  return fallback;
}

/**
 * Call `callback` every `intervalMs` while the tab is visible, and once more
 * when it becomes visible again. `intervalMs <= 0` turns polling off.
 */
export function useVisiblePolling(callback: () => unknown, intervalMs: number): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (intervalMs <= 0) return undefined;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void callbackRef.current();
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void callbackRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}

// =============================================================================
// The list
// =============================================================================

export interface UseBroadcastsResult {
  broadcasts: Broadcast[];
  total: number;
  isLoading: boolean;
  error: string | null;
  /** Run a query, and remember it so `refresh` can repeat it. */
  fetchBroadcasts: (params?: BroadcastListParams) => Promise<void>;
  /** Re-run the last query without raising the loading flag. */
  refresh: () => Promise<void>;
}

export function useBroadcasts(): UseBroadcastsResult {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const lastParams = useRef<BroadcastListParams>({});

  const runQuery = useCallback(
    async (params: BroadcastListParams, showLoading: boolean) => {
      if (showLoading) setIsLoading(true);
      setError(null);
      try {
        const response = await getBroadcasts(params);
        if (isMounted()) {
          setBroadcasts(response.items);
          setTotal(response.meta.totalItems);
        }
      } catch (err) {
        if (isMounted()) {
          setError(messageFor(err, 'Failed to load broadcasts'));
          setBroadcasts([]);
          setTotal(0);
        }
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const fetchBroadcasts = useCallback(
    async (params: BroadcastListParams = {}) => {
      lastParams.current = params;
      await runQuery(params, true);
    },
    [runQuery],
  );

  const refresh = useCallback(async () => {
    await runQuery(lastParams.current, false);
  }, [runQuery]);

  return { broadcasts, total, isLoading, error, fetchBroadcasts, refresh };
}

// =============================================================================
// The writes
// =============================================================================

export interface UseBroadcastActionsResult {
  /** True while any write is in flight. */
  isWorking: boolean;
  error: string | null;
  clearError: () => void;
  create: (body: CreateBroadcastRequest) => Promise<Broadcast | null>;
  cancel: (id: string) => Promise<Broadcast | null>;
  resume: (id: string) => Promise<Broadcast | null>;
  remove: (id: string) => Promise<boolean>;
  sendTest: (body: CreateBroadcastRequest) => Promise<BroadcastTestResult | null>;
}

/**
 * The writes, sharing ONE in-flight flag and ONE error: they all mutate the
 * same list, and a second write started while the first lands would report
 * over the top of it. `onChanged` fires after a write lands (never for a test
 * send, which writes nothing).
 */
export function useBroadcastActions(onChanged?: () => void): UseBroadcastActionsResult {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const run = useCallback(
    async <T,>(
      operation: () => Promise<T>,
      fallback: string,
      notifiesChange = true,
    ): Promise<T | null> => {
      setIsWorking(true);
      setError(null);
      try {
        const result = await operation();
        if (notifiesChange) onChangedRef.current?.();
        return result;
      } catch (err) {
        if (isMounted()) setError(messageFor(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsWorking(false);
      }
    },
    [isMounted],
  );

  const create = useCallback(
    (body: CreateBroadcastRequest) => run(() => createBroadcast(body), 'Failed to create broadcast'),
    [run],
  );
  const cancel = useCallback(
    (id: string) => run(() => cancelBroadcast(id), 'Failed to cancel broadcast'),
    [run],
  );
  const resume = useCallback(
    (id: string) => run(() => resumeBroadcast(id), 'Failed to resume broadcast'),
    [run],
  );
  const remove = useCallback(
    async (id: string) =>
      (await run(async () => {
        await deleteBroadcast(id);
        return true;
      }, 'Failed to delete broadcast')) !== null,
    [run],
  );
  const sendTest = useCallback(
    (body: CreateBroadcastRequest) =>
      run(() => sendTestBroadcast(body), 'Failed to send the test notification', false),
    [run],
  );
  const clearError = useCallback(() => setError(null), []);

  return { isWorking, error, clearError, create, cancel, resume, remove, sendTest };
}
