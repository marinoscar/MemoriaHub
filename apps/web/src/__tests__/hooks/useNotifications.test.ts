/**
 * Unit tests for the useNotifications module-level store (issue #249, epic #240).
 *
 * Covers:
 *  - Badge count fetch on mount (acquire) and via refreshCount
 *  - Panel list fetch via refreshList
 *  - Optimistic markRead / dismiss / markAllRead with rollback-on-failure
 *  - Polling cadence, visibility pause/resume, focus resume
 *  - Reference-counted shared store: two subscribers do not double-poll,
 *    and polling only stops once the LAST subscriber unmounts
 *  - The `enabled` opt-out (unauthenticated / gated surfaces never poll)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the notifications service — the store's only network seam.
// ---------------------------------------------------------------------------
vi.mock('../../services/notifications', () => ({
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

import {
  useNotifications,
  __resetNotificationsStoreForTests,
} from '../../hooks/useNotifications';
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
  dismissNotification,
  markAllNotificationsRead,
} from '../../services/notifications';
import type { NotificationItem, NotificationListResponse } from '../../types/notifications';

const mockGetUnreadCount = vi.mocked(getUnreadCount);
const mockListNotifications = vi.mocked(listNotifications);
const mockMarkNotificationRead = vi.mocked(markNotificationRead);
const mockDismissNotification = vi.mocked(dismissNotification);
const mockMarkAllNotificationsRead = vi.mocked(markAllNotificationsRead);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notif-1',
    circleId: 'circle-1',
    type: 'review_queue_bursts',
    title: 'Burst review ready',
    body: null,
    link: '/bursts',
    data: null,
    readAt: null,
    dismissedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function listResponse(items: NotificationItem[]): NotificationListResponse {
  return {
    items,
    meta: { page: 1, pageSize: 10, totalItems: items.length, totalPages: 1 },
  };
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

const POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNotificationsStoreForTests();
    setVisibility('visible');
    mockGetUnreadCount.mockResolvedValue(0);
    mockListNotifications.mockResolvedValue(listResponse([]));
    mockMarkNotificationRead.mockResolvedValue(undefined);
    mockDismissNotification.mockResolvedValue(undefined);
    mockMarkAllNotificationsRead.mockResolvedValue({ updated: 0 });
  });

  afterEach(() => {
    __resetNotificationsStoreForTests();
    vi.useRealTimers();
    setVisibility('visible');
  });

  // =========================================================================
  // Badge count
  // =========================================================================

  describe('unread count', () => {
    it('starts at 0 with an empty item list before the first fetch resolves', () => {
      mockGetUnreadCount.mockReturnValue(new Promise(() => {})); // never resolves

      const { result } = renderHook(() => useNotifications());

      expect(result.current.unreadCount).toBe(0);
      expect(result.current.items).toEqual([]);
      expect(result.current.hasLoadedList).toBe(false);
    });

    it('fetches the unread count on mount and reflects the server value', async () => {
      mockGetUnreadCount.mockResolvedValue(5);

      const { result } = renderHook(() => useNotifications());

      await waitFor(() => {
        expect(result.current.unreadCount).toBe(5);
      });
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(1);
    });

    it('reflects a zero unread count from the server', async () => {
      mockGetUnreadCount.mockResolvedValue(0);

      const { result } = renderHook(() => useNotifications());

      await waitFor(() => {
        expect(mockGetUnreadCount).toHaveBeenCalled();
      });
      expect(result.current.unreadCount).toBe(0);
    });

    it('refreshCount re-invokes getUnreadCount on demand', async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(mockGetUnreadCount).toHaveBeenCalledTimes(1));

      mockGetUnreadCount.mockResolvedValue(3);
      await act(async () => {
        await result.current.refreshCount();
      });

      expect(result.current.unreadCount).toBe(3);
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
    });

    it('captures an error message when getUnreadCount rejects', async () => {
      mockGetUnreadCount.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => useNotifications());

      await waitFor(() => {
        expect(result.current.error).toBe('network down');
      });
    });
  });

  // =========================================================================
  // Panel list fetch
  // =========================================================================

  describe('refreshList', () => {
    it('is a no-op until called — hasLoadedList starts false', () => {
      const { result } = renderHook(() => useNotifications());
      expect(result.current.hasLoadedList).toBe(false);
      expect(mockListNotifications).not.toHaveBeenCalled();
    });

    it('fetches and populates items, flips hasLoadedList true', async () => {
      const item = makeNotification();
      mockListNotifications.mockResolvedValue(listResponse([item]));

      const { result } = renderHook(() => useNotifications());
      await act(async () => {
        await result.current.refreshList();
      });

      expect(result.current.items).toEqual([item]);
      expect(result.current.hasLoadedList).toBe(true);
      expect(mockListNotifications).toHaveBeenCalledWith({
        status: 'all',
        page: 1,
        pageSize: 10,
      });
    });

    it('sets an error and stops loading when listNotifications rejects', async () => {
      mockListNotifications.mockRejectedValue(new Error('list failed'));

      const { result } = renderHook(() => useNotifications());
      await act(async () => {
        await result.current.refreshList();
      });

      expect(result.current.error).toBe('list failed');
      expect(result.current.isLoading).toBe(false);
    });
  });

  // =========================================================================
  // Optimistic markRead + rollback
  // =========================================================================

  describe('markRead', () => {
    async function seedOneUnreadItem(unreadCount = 1) {
      const item = makeNotification({ readAt: null });
      mockListNotifications.mockResolvedValue(listResponse([item]));
      mockGetUnreadCount.mockResolvedValue(unreadCount);

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.unreadCount).toBe(unreadCount));
      await act(async () => {
        await result.current.refreshList();
      });
      return { result, item };
    }

    it('marks the row read and decrements the badge IMMEDIATELY, before the request resolves', async () => {
      const { result, item } = await seedOneUnreadItem(1);

      let resolveRead!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveRead = resolve;
      });
      mockMarkNotificationRead.mockReturnValue(pending);

      act(() => {
        void result.current.markRead(item.id);
      });

      // Optimistic effect must be visible synchronously, before the request settles.
      expect(result.current.unreadCount).toBe(0);
      expect(result.current.items.find((n) => n.id === item.id)?.readAt).not.toBeNull();

      // The success path also fires a reconciling `fetchCount()` — reflect the
      // now-decremented server truth so that call doesn't fight our assertion.
      mockGetUnreadCount.mockResolvedValue(0);

      await act(async () => {
        resolveRead();
        await pending;
      });

      expect(mockMarkNotificationRead).toHaveBeenCalledWith(item.id);
      // Still marked read after the request settles successfully.
      expect(result.current.unreadCount).toBe(0);
    });

    it('ROLLS BACK the badge and the row on a FAILED request', async () => {
      const { result, item } = await seedOneUnreadItem(1);

      let rejectRead!: (err: unknown) => void;
      const pending = new Promise<void>((_resolve, reject) => {
        rejectRead = reject;
      });
      mockMarkNotificationRead.mockReturnValue(pending);
      // The rollback path also re-fetches the count as a tiebreaker; make that
      // resolve back to the pre-mutation value so we can assert the restored
      // state deterministically.
      mockGetUnreadCount.mockResolvedValue(1);

      act(() => {
        void result.current.markRead(item.id);
      });

      // Optimistic decrement happened…
      expect(result.current.unreadCount).toBe(0);

      await act(async () => {
        rejectRead(new Error('server rejected'));
        await pending.catch(() => undefined);
      });

      // …and is undone once the request fails.
      expect(result.current.unreadCount).toBe(1);
      expect(result.current.items.find((n) => n.id === item.id)?.readAt).toBeNull();
      // The rollback's error message SURVIVES the reconciling count refetch —
      // see the dedicated 'rollback error surface' block below, which covers
      // this for all three mutations.
    });

    it('is a no-op for an already-read notification', async () => {
      const item = makeNotification({ readAt: '2026-08-01T00:00:00.000Z' });
      mockListNotifications.mockResolvedValue(listResponse([item]));

      const { result } = renderHook(() => useNotifications());
      await act(async () => {
        await result.current.refreshList();
      });

      await act(async () => {
        await result.current.markRead(item.id);
      });

      expect(mockMarkNotificationRead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Optimistic dismiss + rollback
  // =========================================================================

  describe('dismiss', () => {
    async function seedOneUnreadItem() {
      const item = makeNotification({ readAt: null });
      mockListNotifications.mockResolvedValue(listResponse([item]));
      mockGetUnreadCount.mockResolvedValue(1);

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.unreadCount).toBe(1));
      await act(async () => {
        await result.current.refreshList();
      });
      return { result, item };
    }

    it('removes the row and decrements the badge immediately', async () => {
      const { result, item } = await seedOneUnreadItem();

      let resolveDismiss!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveDismiss = resolve;
      });
      mockDismissNotification.mockReturnValue(pending);

      act(() => {
        void result.current.dismiss(item.id);
      });

      expect(result.current.items).toEqual([]);
      expect(result.current.unreadCount).toBe(0);

      await act(async () => {
        resolveDismiss();
        await pending;
      });

      expect(mockDismissNotification).toHaveBeenCalledWith(item.id);
    });

    it('restores the row and the badge count on a failed dismiss', async () => {
      const { result, item } = await seedOneUnreadItem();

      let rejectDismiss!: (err: unknown) => void;
      const pending = new Promise<void>((_resolve, reject) => {
        rejectDismiss = reject;
      });
      mockDismissNotification.mockReturnValue(pending);
      mockGetUnreadCount.mockResolvedValue(1);

      act(() => {
        void result.current.dismiss(item.id);
      });
      expect(result.current.items).toEqual([]);

      await act(async () => {
        rejectDismiss(new Error('dismiss failed'));
        await pending.catch(() => undefined);
      });

      expect(result.current.items).toEqual([item]);
      expect(result.current.unreadCount).toBe(1);
      // `error` is asserted in the 'rollback error surface' block below.
    });
  });

  // =========================================================================
  // markAllRead (unscoped — the only form the panel's "Mark all as read" uses)
  // =========================================================================

  describe('markAllRead', () => {
    it('hits the bulk read-all endpoint and zeroes the badge immediately', async () => {
      const items = [
        makeNotification({ id: 'a', readAt: null }),
        makeNotification({ id: 'b', readAt: null }),
      ];
      mockListNotifications.mockResolvedValue(listResponse(items));
      mockGetUnreadCount.mockResolvedValue(2);

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.unreadCount).toBe(2));
      await act(async () => {
        await result.current.refreshList();
      });

      let resolveAll!: () => void;
      const pending = new Promise<{ updated: number }>((resolve) => {
        resolveAll = () => resolve({ updated: 2 });
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);

      act(() => {
        void result.current.markAllRead();
      });

      expect(result.current.unreadCount).toBe(0);
      expect(result.current.items.every((n) => n.readAt !== null)).toBe(true);

      await act(async () => {
        resolveAll();
        await pending;
      });

      expect(mockMarkAllNotificationsRead).toHaveBeenCalledWith(undefined);
    });

    it('rolls back on failure', async () => {
      const items = [makeNotification({ id: 'a', readAt: null })];
      mockListNotifications.mockResolvedValue(listResponse(items));
      mockGetUnreadCount.mockResolvedValue(1);

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.unreadCount).toBe(1));
      await act(async () => {
        await result.current.refreshList();
      });

      let rejectAll!: (err: unknown) => void;
      const pending = new Promise<{ updated: number }>((_resolve, reject) => {
        rejectAll = reject;
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);
      mockGetUnreadCount.mockResolvedValue(1);

      act(() => {
        void result.current.markAllRead();
      });
      expect(result.current.unreadCount).toBe(0);

      await act(async () => {
        rejectAll(new Error('bulk failed'));
        await pending.catch(() => undefined);
      });

      expect(result.current.unreadCount).toBe(1);
      expect(result.current.items[0].readAt).toBeNull();
    });
  });

  // =========================================================================
  // markAllRead SCOPED to a circle
  //
  // Not reachable from the shipped bell panel (which only calls the unscoped
  // form) but it is the exact path issue #250's `/notifications` page takes
  // when a circle filter is active. Regression guard: this used to skip the
  // optimistic decrement entirely, so the badge silently froze.
  // =========================================================================

  describe('markAllRead scoped to a circle', () => {
    /**
     * Two loaded unread rows in circle-1, one in circle-2, and a server badge
     * of 5 — i.e. deliberately MORE unread rows than the store has loaded, which
     * is what makes the scoped decrement an estimate rather than a fact.
     */
    async function seedMixedCircles(unreadCount = 5) {
      const items = [
        makeNotification({ id: 'a', circleId: 'circle-1', readAt: null }),
        makeNotification({ id: 'b', circleId: 'circle-1', readAt: null }),
        makeNotification({ id: 'c', circleId: 'circle-2', readAt: null }),
      ];
      mockListNotifications.mockResolvedValue(listResponse(items));
      mockGetUnreadCount.mockResolvedValue(unreadCount);

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.unreadCount).toBe(unreadCount));
      await act(async () => {
        await result.current.refreshList();
      });
      return { result, items };
    }

    it('decrements the badge OPTIMISTICALLY by the loaded unread rows in that circle', async () => {
      const { result } = await seedMixedCircles(5);

      let resolveAll!: () => void;
      const pending = new Promise<{ updated: number }>((resolve) => {
        resolveAll = () => resolve({ updated: 2 });
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);

      act(() => {
        void result.current.markAllRead('circle-1');
      });

      // Two of the five unread rows are loaded and in scope → 5 - 2 = 3,
      // visible synchronously, before the request settles.
      expect(result.current.unreadCount).toBe(3);
      expect(mockMarkAllNotificationsRead).toHaveBeenCalledWith('circle-1');

      await act(async () => {
        resolveAll();
        await pending;
      });
    });

    it('only marks rows of the scoped circle read, leaving other circles untouched', async () => {
      const { result } = await seedMixedCircles(5);

      let resolveAll!: () => void;
      const pending = new Promise<{ updated: number }>((resolve) => {
        resolveAll = () => resolve({ updated: 2 });
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);

      act(() => {
        void result.current.markAllRead('circle-1');
      });

      const byId = (id: string) => result.current.items.find((n) => n.id === id);
      expect(byId('a')?.readAt).not.toBeNull();
      expect(byId('b')?.readAt).not.toBeNull();
      expect(byId('c')?.readAt).toBeNull();

      await act(async () => {
        resolveAll();
        await pending;
      });
    });

    it('replaces the estimate with the server’s exact `updated` count', async () => {
      const { result } = await seedMixedCircles(5);

      let resolveAll!: () => void;
      const pending = new Promise<{ updated: number }>((resolve) => {
        // The server flipped FOUR rows — two more than the store had loaded,
        // which is precisely the case the optimistic estimate cannot know.
        resolveAll = () => resolve({ updated: 4 });
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);

      act(() => {
        void result.current.markAllRead('circle-1');
      });
      expect(result.current.unreadCount).toBe(3); // the estimate

      // Hang the reconciling fetchCount so this assertion isolates the
      // `updated`-derived correction rather than the later refetch.
      mockGetUnreadCount.mockReturnValue(new Promise(() => {}));

      await act(async () => {
        resolveAll();
        await pending;
      });

      expect(result.current.unreadCount).toBe(1); // 5 - 4
    });

    it('ends server-accurate even when the estimate and `updated` both disagree', async () => {
      const { result } = await seedMixedCircles(5);

      mockMarkAllNotificationsRead.mockResolvedValue({ updated: 4 });
      // The reconciling refetch is the final authority; pick a value that
      // matches neither the estimate (3) nor the `updated` correction (1).
      mockGetUnreadCount.mockResolvedValue(7);

      await act(async () => {
        await result.current.markAllRead('circle-1');
      });

      await waitFor(() => {
        expect(result.current.unreadCount).toBe(7);
      });
    });

    it('never drives the badge below zero when the estimate overshoots', async () => {
      // Server badge of 1 but two loaded unread rows in scope (possible when a
      // poll landed between the list fetch and the click).
      const { result } = await seedMixedCircles(1);

      let resolveAll!: () => void;
      const pending = new Promise<{ updated: number }>((resolve) => {
        resolveAll = () => resolve({ updated: 2 });
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);

      act(() => {
        void result.current.markAllRead('circle-1');
      });

      expect(result.current.unreadCount).toBe(0); // clamped, not -1

      mockGetUnreadCount.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        resolveAll();
        await pending;
      });

      expect(result.current.unreadCount).toBe(0); // 1 - 2 clamped, not -1
    });

    it('rolls the scoped decrement back on failure', async () => {
      const { result, items } = await seedMixedCircles(5);

      let rejectAll!: (err: unknown) => void;
      const pending = new Promise<{ updated: number }>((_resolve, reject) => {
        rejectAll = reject;
      });
      mockMarkAllNotificationsRead.mockReturnValue(pending);
      mockGetUnreadCount.mockResolvedValue(5);

      act(() => {
        void result.current.markAllRead('circle-1');
      });
      expect(result.current.unreadCount).toBe(3);

      await act(async () => {
        rejectAll(new Error('scoped bulk failed'));
        await pending.catch(() => undefined);
      });

      expect(result.current.unreadCount).toBe(5);
      expect(result.current.items).toEqual(items);
      expect(result.current.error).toBe('scoped bulk failed');
    });
  });

  // =========================================================================
  // Rollback error surface
  //
  // The rollback fires a reconciling count refetch (a poll landing mid-flight
  // can make the restored snapshot's own count stale, so the server is the
  // tiebreaker). That refetch must NOT clear the error the rollback just set —
  // otherwise the badge reverts correctly but the user is never told why.
  // =========================================================================

  describe('rollback error surface', () => {
    async function seedOne(unreadCount = 1) {
      const item = makeNotification({ readAt: null });
      mockListNotifications.mockResolvedValue(listResponse([item]));
      mockGetUnreadCount.mockResolvedValue(unreadCount);

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.unreadCount).toBe(unreadCount));
      await act(async () => {
        await result.current.refreshList();
      });
      return { result, item };
    }

    it('keeps the markRead failure message even though the reconciling refetch SUCCEEDS', async () => {
      const { result, item } = await seedOne(1);
      mockMarkNotificationRead.mockRejectedValue(new Error('server rejected'));
      mockGetUnreadCount.mockResolvedValue(1); // the reconcile succeeds

      await act(async () => {
        await result.current.markRead(item.id);
      });

      // Reconciliation still happened (mount + refresh + reconcile)…
      await waitFor(() => {
        expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
      });
      expect(result.current.unreadCount).toBe(1);
      // …and the error survived it.
      expect(result.current.error).toBe('server rejected');
    });

    it('keeps the dismiss failure message', async () => {
      const { result, item } = await seedOne(1);
      mockDismissNotification.mockRejectedValue(new Error('dismiss failed'));
      mockGetUnreadCount.mockResolvedValue(1);

      await act(async () => {
        await result.current.dismiss(item.id);
      });

      await waitFor(() => {
        expect(result.current.error).toBe('dismiss failed');
      });
      expect(result.current.items).toEqual([item]);
    });

    it('keeps the markAllRead failure message', async () => {
      const { result } = await seedOne(1);
      mockMarkAllNotificationsRead.mockRejectedValue(new Error('bulk failed'));
      mockGetUnreadCount.mockResolvedValue(1);

      await act(async () => {
        await result.current.markAllRead();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('bulk failed');
      });
      expect(result.current.unreadCount).toBe(1);
    });

    it('does not let a FAILING reconcile overwrite the mutation error either', async () => {
      const { result, item } = await seedOne(1);
      mockMarkNotificationRead.mockRejectedValue(new Error('server rejected'));
      mockGetUnreadCount.mockRejectedValue(new Error('count also down'));

      await act(async () => {
        await result.current.markRead(item.id);
      });

      // The failed WRITE is the more actionable of the two messages.
      await waitFor(() => {
        expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
      });
      expect(result.current.error).toBe('server rejected');
    });

    it('clears the rollback error on the next ordinary successful refresh', async () => {
      const { result, item } = await seedOne(1);
      mockMarkNotificationRead.mockRejectedValue(new Error('server rejected'));
      mockGetUnreadCount.mockResolvedValue(1);

      await act(async () => {
        await result.current.markRead(item.id);
      });
      await waitFor(() => expect(result.current.error).toBe('server rejected'));

      // An ordinary poll / explicit refresh still clears a stale error — only
      // the rollback's own reconciling read is prevented from doing so.
      await act(async () => {
        await result.current.refreshCount();
      });

      expect(result.current.error).toBeNull();
    });
  });

  // =========================================================================
  // Polling cadence + visibility pause/resume
  // =========================================================================

  describe('polling / visibility', () => {
    it('polls again after POLL_INTERVAL_MS while the tab stays visible', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        await Promise.resolve();
      });
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
    });

    it('stops issuing requests while the tab is hidden', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeHide = mockGetUnreadCount.mock.calls.length;

      act(() => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
        await Promise.resolve();
      });

      expect(mockGetUnreadCount.mock.calls.length).toBe(callsBeforeHide);
    });

    it('refetches IMMEDIATELY and resumes the interval when the tab becomes visible again', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const callsWhileHidden = mockGetUnreadCount.mock.calls.length;

      // Coming back to the tab triggers an immediate refetch — no need to
      // advance the timer at all.
      await act(async () => {
        setVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(mockGetUnreadCount.mock.calls.length).toBe(callsWhileHidden + 1);

      // …and the interval is running again.
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        await Promise.resolve();
      });
      expect(mockGetUnreadCount.mock.calls.length).toBe(callsWhileHidden + 2);
    });

    it('refetches on window focus while the tab is visible', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeFocus = mockGetUnreadCount.mock.calls.length;

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });

      expect(mockGetUnreadCount.mock.calls.length).toBe(callsBeforeFocus + 1);
    });

    it('does NOT refetch on focus while the tab is hidden', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const callsWhileHidden = mockGetUnreadCount.mock.calls.length;

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });

      expect(mockGetUnreadCount.mock.calls.length).toBe(callsWhileHidden);
    });
  });

  // =========================================================================
  // Shared store: reference-counted subscribers
  // =========================================================================

  describe('shared store across multiple subscribers', () => {
    it('mounting two consumers issues only ONE unread-count fetch, not two', async () => {
      renderHook(() => useNotifications());
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockGetUnreadCount).toHaveBeenCalledTimes(1);
    });

    it('a single shared poller ticks once per interval regardless of subscriber count', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        await Promise.resolve();
      });

      // One additional tick from the ONE shared interval — not two.
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
    });

    it('polling continues after only ONE of two subscribers unmounts', async () => {
      vi.useFakeTimers();
      const first = renderHook(() => useNotifications());
      renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });

      first.unmount();

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        await Promise.resolve();
      });

      // The still-mounted second subscriber keeps the shared poller alive.
      expect(mockGetUnreadCount).toHaveBeenCalledTimes(2);
    });

    it('polling stops once the LAST subscriber unmounts', async () => {
      vi.useFakeTimers();
      const first = renderHook(() => useNotifications());
      const second = renderHook(() => useNotifications());

      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeUnmount = mockGetUnreadCount.mock.calls.length;

      first.unmount();
      second.unmount();

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
        await Promise.resolve();
      });

      expect(mockGetUnreadCount.mock.calls.length).toBe(callsBeforeUnmount);
    });
  });

  // =========================================================================
  // enabled: false — opt out of polling entirely
  // =========================================================================

  describe('enabled option', () => {
    it('never fetches or polls when enabled is false', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications({ enabled: false }));

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
        await Promise.resolve();
      });

      expect(mockGetUnreadCount).not.toHaveBeenCalled();
    });

    it('refreshList / refreshCount are no-ops while disabled', async () => {
      const { result } = renderHook(() => useNotifications({ enabled: false }));

      await act(async () => {
        await result.current.refreshList();
        await result.current.refreshCount();
      });

      expect(mockListNotifications).not.toHaveBeenCalled();
      expect(mockGetUnreadCount).not.toHaveBeenCalled();
    });
  });
});
