import { useEffect, useRef } from 'react';
import type { RunStatus } from '../types/runs';
import { isTerminalRunStatus } from '../utils/runFormat';

/** Poll cadence shared by every run page. */
export const POLL_MS = 2000;

export interface UseRunPollingOptions {
  /** The run being watched. Polling is inert until this is defined. */
  runId: string | undefined | null;
  /**
   * The run's current status. Polling is inert until the run has loaded
   * (`undefined`/`null`) and stops as soon as the status becomes terminal.
   */
  status: RunStatus | undefined | null;
  /** Refetch callback, invoked with `runId` on every tick. */
  onPoll: (runId: string) => void | Promise<void>;
  /** Poll interval in ms. Defaults to `POLL_MS` (2s). */
  intervalMs?: number;
  /** Escape hatch to suspend polling without unmounting the host. */
  enabled?: boolean;
}

/**
 * Poll a run's detail endpoint while it is non-terminal (issue #190).
 *
 * Extracted verbatim in behaviour from the three identical `pollRef` +
 * `setInterval` effects in `WorkflowRunPage`, `TrashEmptyRunPage` and
 * `LocationSuggestionRunPage`. The interval is torn down when the run reaches
 * a terminal status and on unmount, so a backgrounded tab never leaks a timer.
 *
 * `onPoll` is held in a ref, so passing an inline arrow function does not
 * restart the interval on every render — only `runId`, `status`, `intervalMs`
 * and `enabled` do.
 */
export function useRunPolling({
  runId,
  status,
  onPoll,
  intervalMs = POLL_MS,
  enabled = true,
}: UseRunPollingOptions): void {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onPollRef = useRef(onPoll);

  // Keep the latest callback without re-arming the interval.
  useEffect(() => {
    onPollRef.current = onPoll;
  }, [onPoll]);

  useEffect(() => {
    const clear = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    // Not ready, disabled, or already finished — nothing to poll.
    if (!enabled || !runId || !status || isTerminalRunStatus(status)) {
      clear();
      return;
    }

    clear();
    const id = runId;
    pollRef.current = setInterval(() => {
      void onPollRef.current(id);
    }, intervalMs);

    return clear;
  }, [runId, status, intervalMs, enabled]);
}
