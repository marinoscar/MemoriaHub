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
 * LIVE STREAM (issue #485)
 * ------------------------
 * The first enabled subscriber also opens ONE `GET /api/notifications/stream`
 * connection (`services/notificationStream.ts`) for the whole tab, and the last
 * one to leave closes it — the same ref count as the poller. While the stream
 * is OPEN:
 *   - the 60s poll is replaced by a slow `STREAM_SAFETY_POLL_MS` safety net
 *     (the API's stream registry is per process, so behind several replicas a
 *     connected tab can still miss a frame);
 *   - every connect AND reconnect refetches the count (and the panel list if it
 *     was ever opened), because nothing published during a gap is replayed;
 *   - each `notification` frame is applied in place: a row already in the
 *     loaded panel list is replaced, a new one is prepended, and the badge
 *     takes the frame's server-read `unreadCount` when present — otherwise it
 *     moves optimistically and is reconciled with one debounced count read (a
 *     counted event re-publishes an EXISTING row, and only the server knows
 *     whether that row was already unread).
 * When the stream drops, the store falls straight back to 60s polling until
 * it reconnects. A missed frame is therefore a missed toast, never a stale
 * badge.
 *
 * HIDDEN TABS keep the stream open (only the poll is paused): a hidden tab is
 * exactly where an OS toast is useful, and one idle connection costs nothing
 * but heartbeats.
 *
 * TOASTS. A frame may raise an OS notification (`showAppNotification`) only
 * when ALL of: the server set `toast`; permission is `granted`; the tab is
 * NOT both visible and focused (a focused user already sees the bell move);
 * the id is new to this tab, or the frame is a `reunread` (a counted row
 * re-published as its count grows toasts once, not per increment); and NOT (`pushed` && this browser holds an
 * active push subscription for the current VAPID key) — in that case the
 * service worker's `push` handler already shows it. Duplicates across tabs are
 * collapsed by the notification `tag` (see `browserNotifications.ts`).
 *
 * ERRORS are captured into `error` and never thrown — a notification badge
 * must not be able to take down the AppBar.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  dismissNotification,
  getNotificationConfig,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notifications';
import {
  connectNotificationStream,
  type SseConnection,
  type SseState,
} from '../services/notificationStream';
import { showAppNotification } from '../services/browserNotifications';
import { hasActivePushSubscription } from '../services/pushSubscription';
import type {
  NotificationClientConfig,
  NotificationItem,
  NotificationStreamEvent,
} from '../types/notifications';

/** Badge poll cadence while the live stream is NOT open. */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Safety-net poll cadence while the live stream IS open. The stream carries
 * the updates; this only covers a frame lost to a replica the tab is not
 * connected to.
 */
export const STREAM_SAFETY_POLL_MS = 5 * 60_000;

/** Debounce for the count reconcile after a burst of streamed frames. */
export const COUNT_RECONCILE_DELAY_MS = 750;

/** Upper bound on the ids remembered as "already seen by this tab". */
const SEEN_IDS_LIMIT = 500;

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
  /** True while the live notification stream is connected. */
  isLive: boolean;
}

const INITIAL_STATE: NotificationsState = {
  unreadCount: 0,
  items: [],
  isLoading: false,
  hasLoadedList: false,
  error: null,
  isLive: false,
};

let state: NotificationsState = INITIAL_STATE;
const listeners = new Set<() => void>();

/** Number of currently-mounted subscribers that want polling. */
let enabledSubscribers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let domListenersAttached = false;

// --- live stream state (issue #485) ---
let stream: SseConnection | null = null;
let streamOpen = false;
let countReconcileTimer: ReturnType<typeof setTimeout> | null = null;
/** Ids this tab has already accounted for (fetched or streamed). */
const seenIds = new Set<string>();
/** `GET /api/notifications/config`, fetched lazily for the push dedupe. */
let configPromise: Promise<NotificationClientConfig | null> | null = null;
/**
 * What to do when the user clicks a page-raised toast — registered by the
 * shell (`useNotificationClickHandling`), which owns the router and the circle
 * context this module-level store cannot reach.
 */
let openHandler: ((notification: NotificationItem) => void) | null = null;

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
    const items = response.items ?? [];
    items.forEach((n) => rememberId(n.id));
    setState({
      items,
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
  pollTimer = setInterval(
    () => {
      void fetchCount();
    },
    streamOpen ? STREAM_SAFETY_POLL_MS : POLL_INTERVAL_MS,
  );
}

/** Re-arm the poll at whatever cadence the stream state now calls for. */
function restartTimer(): void {
  stopTimer();
  startTimer();
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
    // Opened even while hidden — see "HIDDEN TABS" in the header.
    openStream();
  }
}

function release(): void {
  enabledSubscribers = Math.max(0, enabledSubscribers - 1);
  if (enabledSubscribers === 0) {
    stopTimer();
    detachDomListeners();
    closeStream();
  }
}

// --- live stream (issue #485) -----------------------------------------------

function rememberId(id: string): void {
  seenIds.delete(id);
  seenIds.add(id);
  if (seenIds.size > SEEN_IDS_LIMIT) {
    const oldest = seenIds.values().next().value;
    if (oldest !== undefined) seenIds.delete(oldest);
  }
}

function canStream(): boolean {
  return (
    typeof fetch === 'function' &&
    typeof TextDecoder !== 'undefined' &&
    typeof ReadableStream !== 'undefined'
  );
}

function openStream(): void {
  if (stream || !canStream()) return;
  stream = connectNotificationStream({
    onOpen: handleStreamOpen,
    onStateChange: handleStreamState,
    onEvent: handleStreamEvent,
  });
}

function closeStream(): void {
  stream?.close();
  stream = null;
  streamOpen = false;
  if (countReconcileTimer !== null) {
    clearTimeout(countReconcileTimer);
    countReconcileTimer = null;
  }
  seenIds.clear();
  configPromise = null;
  if (state.isLive) setState({ isLive: false });
}

/**
 * Connected — the first time or after a gap. The stream replays nothing, so
 * re-read the truth, and slow the poll down to the safety-net cadence.
 */
function handleStreamOpen(): void {
  if (enabledSubscribers === 0) return;
  streamOpen = true;
  setState({ isLive: true });
  restartTimer();
  void fetchCount();
  if (state.hasLoadedList) void fetchList();
}

function handleStreamState(next: SseState): void {
  if (next === 'open' || !streamOpen) return;
  // Dropped: fall straight back to the 60s poll until the stream returns.
  streamOpen = false;
  setState({ isLive: false });
  restartTimer();
}

function scheduleCountReconcile(): void {
  if (countReconcileTimer !== null) clearTimeout(countReconcileTimer);
  countReconcileTimer = setTimeout(() => {
    countReconcileTimer = null;
    if (enabledSubscribers > 0) void fetchCount();
  }, COUNT_RECONCILE_DELAY_MS);
}

function handleStreamEvent(event: NotificationStreamEvent): void {
  if (enabledSubscribers === 0) return;

  if (event.type === 'sync') {
    void fetchCount();
    if (state.hasLoadedList) void fetchList();
    return;
  }

  const incoming = event.notification;
  const isNewToTab = !seenIds.has(incoming.id);
  rememberId(incoming.id);

  const existing = state.items.find((n) => n.id === incoming.id);
  const isLiveRow = incoming.dismissedAt === null;
  const isUnread = isLiveRow && incoming.readAt === null;

  let items = state.items;
  if (state.hasLoadedList) {
    if (existing) {
      items = isLiveRow
        ? state.items.map((n) => (n.id === incoming.id ? incoming : n))
        : state.items.filter((n) => n.id !== incoming.id);
    } else if (isLiveRow) {
      items = [incoming, ...state.items].slice(0, NOTIFICATION_PANEL_PAGE_SIZE);
    }
  }

  // Optimistic badge move; the debounced reconcile below is the authority.
  let delta = 0;
  if (existing) {
    delta = (isUnread ? 1 : 0) - (existing.readAt === null ? 1 : 0);
  } else if (isUnread && isNewToTab) {
    delta = 1;
  }

  if (typeof event.unreadCount === 'number') {
    // The server read the badge right after this write: exact, no reconcile.
    setState({ items, unreadCount: event.unreadCount });
  } else {
    setState({ items, unreadCount: Math.max(0, state.unreadCount + delta) });
    scheduleCountReconcile();
  }

  // Once per id per tab — except a `reunread` (a review queue grew past what
  // the user last saw), which is genuinely new information.
  if (event.toast && isUnread && (isNewToTab || event.reason === 'reunread')) {
    void maybeRaiseToast(incoming, event.pushed);
  }
}

function loadConfig(): Promise<NotificationClientConfig | null> {
  if (!configPromise) {
    const pending: Promise<NotificationClientConfig | null> = getNotificationConfig().catch(
      () => {
        // Not cached: the next pushed frame retries.
        if (configPromise === pending) configPromise = null;
        return null;
      },
    );
    configPromise = pending;
  }
  return configPromise;
}

function isVisibleAndFocused(): boolean {
  try {
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return false;
  }
}

function permissionGranted(): boolean {
  try {
    return typeof window !== 'undefined' && window.Notification?.permission === 'granted';
  } catch {
    return false;
  }
}

async function maybeRaiseToast(notification: NotificationItem, pushed: boolean): Promise<void> {
  if (!permissionGranted()) return;
  if (isVisibleAndFocused()) return;

  if (pushed) {
    // The service worker's `push` handler will show this one — unless this
    // browser holds no live subscription, in which case the page must.
    let serviceWorkerWillShowIt = false;
    try {
      const config = await loadConfig();
      if (config?.pushEnabled && config.vapidPublicKey) {
        serviceWorkerWillShowIt = await hasActivePushSubscription(config.vapidPublicKey);
      }
    } catch {
      serviceWorkerWillShowIt = false;
    }
    if (serviceWorkerWillShowIt) return;
  }

  if (enabledSubscribers === 0) return;
  await showAppNotification(notification, (clicked) => {
    void markReadAction(clicked.id);
    openHandler?.(clicked);
  });
}

/**
 * Mark one notification read from OUTSIDE a subscribing component — the
 * shell's service-worker click handler and the `?n=<id>` cold-open path (issue
 * #486). Same optimistic write as `useNotifications().markRead`, without
 * subscribing the caller to every store change.
 */
export function markNotificationReadById(id: string): Promise<void> {
  return markReadAction(id);
}

/**
 * Register what a click on a page-raised toast should do (navigate, switching
 * circle first). Returns an unregister function. Only the most recent
 * registration is kept — the shell mounts exactly one.
 */
export function setNotificationOpenHandler(
  handler: ((notification: NotificationItem) => void) | null,
): () => void {
  openHandler = handler;
  return () => {
    if (openHandler === handler) openHandler = null;
  };
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
  /** True while the live stream is connected (badge updates are instant). */
  isLive: boolean;
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
    isLive: snapshot.isLive,
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
  closeStream();
  openHandler = null;
  enabledSubscribers = 0;
  state = INITIAL_STATE;
  listeners.clear();
}
