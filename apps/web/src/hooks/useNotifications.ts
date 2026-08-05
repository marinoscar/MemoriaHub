/**
 * useNotifications — the single shared source of notification state (issue #249).
 *
 * WHY A MODULE-LEVEL STORE AND NOT A NORMAL HOOK
 * ----------------------------------------------
 * More than one surface needs the same unread count: the AppBar bell (#249)
 * and, next, the sidebar entry and the `/notifications` page (#250). Written
 * as an ordinary `useState` + `setInterval` hook, every one of those mounts
 * would start its OWN 60s poller and they would drift out of sync after a
 * mutation. So the polling loop, the timer and the cached state live once at
 * module scope; `useNotifications()` is just a subscriber.
 *
 * The store is reference-counted: the poll starts when the first *enabled*
 * subscriber mounts and stops when the last one unmounts, so nothing polls on
 * the login screen or in a test that never renders the bell.
 *
 * A context provider would work too, but would have to be threaded through
 * `App.tsx` AND every test wrapper; a module store needs neither, which keeps
 * the bell from being able to crash a tree that forgot to wrap it.
 *
 * POLLING / VISIBILITY
 * --------------------
 * - Unread count polls every `POLL_INTERVAL_MS` (60s) — the count endpoint is
 *   cheap and server-cached ~2s.
 * - Polling PAUSES entirely while `document.visibilityState === 'hidden'`: the
 *   interval is torn down, not merely skipped, so a backgrounded tab issues
 *   zero requests.
 * - Returning to the tab (`visibilitychange` → visible) or refocusing the
 *   window (`focus`) triggers an immediate refetch and restarts the interval,
 *   so the badge is never stale by more than the time since focus.
 * - The panel's list is NOT polled. It is fetched on demand (`refreshList`)
 *   when the popover opens and after mutations, so a closed bell costs exactly
 *   one small integer per minute.
 *
 * ERRORS are captured into `error` and never thrown — a notification badge
 * must not be able to take down the AppBar.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  dismissNotification,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notifications';
import type { NotificationItem } from '../types/notifications';

/** Badge poll cadence. */
const POLL_INTERVAL_MS = 60_000;

/** How many rows the bell popover shows. */
export const NOTIFICATION_PANEL_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationsState {
  unreadCount: number;
  items: NotificationItem[];
  /** True while the panel list is being (re)fetched for the first time. */
  isLoading: boolean;
  /** True once a list fetch has completed at least once. */
  hasLoadedList: boolean;
  error: string | null;
}

const INITIAL_STATE: NotificationsState = {
  unreadCount: 0,
  items: [],
  isLoading: false,
  hasLoadedList: false,
  error: null,
};

let state: NotificationsState = INITIAL_STATE;
const listeners = new Set<() => void>();

/** Number of currently-mounted subscribers that want polling. */
let enabledSubscribers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let domListenersAttached = false;

function getSnapshot(): NotificationsState {
  return state;
}

function setState(patch: Partial<NotificationsState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// --- network ---------------------------------------------------------------

/**
 * Refetch the badge count *for its own sake* (mount, poll tick, focus, explicit
 * `refreshCount`, and the success path of a mutation).
 *
 * A success here clears `error`, because a working read is genuine evidence the
 * previously-reported problem is over.
 */
async function fetchCount(): Promise<void> {
  try {
    const count = await getUnreadCount();
    setState({ unreadCount: count, error: null });
  } catch (err) {
    setState({ error: errorMessage(err, 'Failed to load notifications') });
  }
}

/**
 * Refetch the badge count purely to RECONCILE it, leaving `error` untouched.
 *
 * Used by `rollback()` only. The difference from `fetchCount` is the whole
 * point: after a failed mutation the store has just set an error the user still
 * needs to see, and a successful count read says nothing about whether the
 * *write* that failed would now succeed — so clearing the error here would
 * revert the badge correctly while silently swallowing the reason (the panel's
 * error `Alert` would flash, or more likely never render at all).
 *
 * A failure is swallowed rather than overwriting `error`: the mutation failure
 * is the more actionable message of the two, and a persistent outage will be
 * reported by the next ordinary poll through `fetchCount` anyway.
 */
async function reconcileCount(): Promise<void> {
  try {
    const count = await getUnreadCount();
    setState({ unreadCount: count });
  } catch {
    // Intentionally ignored — see above.
  }
}

async function fetchList(): Promise<void> {
  if (!state.hasLoadedList) setState({ isLoading: true });
  try {
    const response = await listNotifications({
      status: 'all',
      page: 1,
      pageSize: NOTIFICATION_PANEL_PAGE_SIZE,
    });
    setState({
      items: response.items ?? [],
      isLoading: false,
      hasLoadedList: true,
      error: null,
    });
  } catch (err) {
    setState({
      isLoading: false,
      error: errorMessage(err, 'Failed to load notifications'),
    });
  }
}

// --- polling lifecycle -----------------------------------------------------

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function stopTimer(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startTimer(): void {
  if (pollTimer !== null || enabledSubscribers === 0 || isHidden()) return;
  pollTimer = setInterval(() => {
    void fetchCount();
  }, POLL_INTERVAL_MS);
}

/** Immediate refetch + (re)start the interval. Used on focus / tab-visible. */
function resumePolling(): void {
  if (enabledSubscribers === 0) return;
  void fetchCount();
  // Refresh the open panel's rows too, if it has ever been opened.
  if (state.hasLoadedList) void fetchList();
  startTimer();
}

function handleVisibilityChange(): void {
  if (isHidden()) {
    stopTimer();
  } else {
    resumePolling();
  }
}

function handleFocus(): void {
  if (isHidden()) return;
  resumePolling();
}

function attachDomListeners(): void {
  if (domListenersAttached || typeof window === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleFocus);
  domListenersAttached = true;
}

function detachDomListeners(): void {
  if (!domListenersAttached || typeof window === 'undefined') return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('focus', handleFocus);
  domListenersAttached = false;
}

function acquire(): void {
  enabledSubscribers += 1;
  if (enabledSubscribers === 1) {
    attachDomListeners();
    if (!isHidden()) {
      void fetchCount();
      startTimer();
    }
  }
}

function release(): void {
  enabledSubscribers = Math.max(0, enabledSubscribers - 1);
  if (enabledSubscribers === 0) {
    stopTimer();
    detachDomListeners();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- mutations (optimistic, with rollback) ---------------------------------

/**
 * Restore a pre-mutation snapshot after a failed request.
 *
 * Assigns `state` wholesale (rather than going through `setState`, which
 * merges) so nothing from the failed optimistic write survives, then kicks off
 * a count refetch: the snapshot's `unreadCount` may itself be stale if a poll
 * landed while the mutation was in flight, and the server is the tiebreaker.
 *
 * That reconciling refetch deliberately goes through `reconcileCount` and NOT
 * `fetchCount`, so it cannot clear the error being set on the line above. With
 * `fetchCount` the rollback was only half-working: the badge reverted, but the
 * cheap count read almost always won the race and reset `error` to null, so the
 * user was never told the write had failed.
 */
function rollback(previous: NotificationsState, err: unknown, fallback: string): void {
  state = { ...previous, error: errorMessage(err, fallback) };
  listeners.forEach((l) => l());
  void reconcileCount();
}

/**
 * Mark one row read.
 *
 * Optimistic in the same shape as `MediaGallery`/`MediaLightbox`'s favorite
 * toggle: apply locally first so the badge drops instantly, then reconcile —
 * and restore the exact pre-mutation snapshot if the request fails.
 */
async function markReadAction(id: string): Promise<void> {
  const target = state.items.find((n) => n.id === id);
  if (target?.readAt) return; // already read — nothing to do
  const previous = state;

  setState({
    items: state.items.map((n) =>
      n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
    ),
    unreadCount: Math.max(0, state.unreadCount - 1),
  });

  try {
    await markNotificationRead(id);
  } catch (err) {
    rollback(previous, err, 'Failed to mark as read');
    return;
  }
  void fetchCount();
}

/** Dismiss one row — it disappears from the panel (dismissed rows are excluded). */
async function dismissAction(id: string): Promise<void> {
  const previous = state;
  const target = state.items.find((n) => n.id === id);
  const wasUnread = Boolean(target && !target.readAt);

  setState({
    items: state.items.filter((n) => n.id !== id),
    unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
  });

  try {
    await dismissNotification(id);
  } catch (err) {
    rollback(previous, err, 'Failed to dismiss notification');
    return;
  }
  void fetchList();
  void fetchCount();
}

/**
 * Mark everything read (optionally scoped to a circle).
 *
 * OPTIMISTIC DECREMENT — exact when unscoped, an ESTIMATE when scoped.
 *
 * Unscoped, every unread row is being read, so the badge is exactly 0.
 *
 * Scoped to a circle (the form issue #250's `/notifications` page uses when a
 * circle filter is active) the store CANNOT know the true number: it only holds
 * the rows it has loaded — at most `NOTIFICATION_PANEL_PAGE_SIZE` of them — so
 * the user may well have unread rows in that circle the store has never seen.
 * We therefore decrement by the count of *loaded* unread rows in that circle,
 * which is a lower bound: the badge can only ever be momentarily too HIGH, never
 * too low. That direction is chosen on purpose — an over-reporting badge is
 * merely stale, an under-reporting one hides work the user still has to do.
 *
 * The estimate is then replaced twice over: first by the server's exact
 * `updated` row count as soon as the response lands, then by the reconciling
 * `fetchCount()`, which is the final authority. So the badge always converges on
 * the server value regardless of how far off the optimistic step was.
 */
async function markAllReadAction(circleId?: string): Promise<void> {
  const previous = state;
  const now = new Date().toISOString();

  const loadedUnreadInScope = circleId
    ? state.items.filter((n) => !n.readAt && n.circleId === circleId).length
    : 0;

  setState({
    items: state.items.map((n) =>
      n.readAt || (circleId && n.circleId !== circleId) ? n : { ...n, readAt: now },
    ),
    unreadCount: circleId ? Math.max(0, state.unreadCount - loadedUnreadInScope) : 0,
  });

  let updated: number | undefined;
  try {
    const result = await markAllNotificationsRead(circleId);
    updated = result?.updated;
  } catch (err) {
    rollback(previous, err, 'Failed to mark all as read');
    return;
  }

  // Swap the estimate for the server's exact count of rows it actually flipped.
  // Only for the scoped path — unscoped already landed on an exact 0, and
  // re-deriving it from `previous` would just reintroduce staleness.
  if (circleId && typeof updated === 'number') {
    setState({ unreadCount: Math.max(0, previous.unreadCount - updated) });
  }

  void fetchCount();
  void fetchList();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseNotificationsOptions {
  /**
   * When false the subscriber does not participate in polling (and does not
   * start it). Hooks cannot be called conditionally, so an unauthenticated
   * surface passes `enabled: false` rather than skipping the call — the same
   * pattern `useReviewCounts` uses (issue #204). Default: true.
   */
  enabled?: boolean;
}

export interface UseNotificationsResult {
  unreadCount: number;
  /** The most recent `NOTIFICATION_PANEL_PAGE_SIZE` live rows. */
  items: NotificationItem[];
  isLoading: boolean;
  hasLoadedList: boolean;
  error: string | null;
  /** Refetch the panel list (call when opening the popover). */
  refreshList: () => Promise<void>;
  /** Refetch the badge count. */
  refreshCount: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  markAllRead: (circleId?: string) => Promise<void>;
}

export function useNotifications(
  options: UseNotificationsOptions = {},
): UseNotificationsResult {
  const { enabled = true } = options;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled) return;
    acquire();
    return release;
  }, [enabled]);

  const refreshList = useCallback(async () => {
    if (!enabled) return;
    await fetchList();
  }, [enabled]);

  const refreshCount = useCallback(async () => {
    if (!enabled) return;
    await fetchCount();
  }, [enabled]);

  const markRead = useCallback(async (id: string) => {
    await markReadAction(id);
  }, []);

  const dismiss = useCallback(async (id: string) => {
    await dismissAction(id);
  }, []);

  const markAllRead = useCallback(async (circleId?: string) => {
    await markAllReadAction(circleId);
  }, []);

  return {
    unreadCount: snapshot.unreadCount,
    items: snapshot.items,
    isLoading: snapshot.isLoading,
    hasLoadedList: snapshot.hasLoadedList,
    error: snapshot.error,
    refreshList,
    refreshCount,
    markRead,
    dismiss,
    markAllRead,
  };
}

/**
 * Test-only reset of the module store.
 *
 * Exported because the store outlives React unmounts by design; without this a
 * test's badge count would leak into the next test in the same file.
 */
export function __resetNotificationsStoreForTests(): void {
  stopTimer();
  detachDomListeners();
  enabledSubscribers = 0;
  state = INITIAL_STATE;
  listeners.clear();
}
