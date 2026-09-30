/**
 * useNotifications — the live stream path (issue #485, epic #481).
 *
 * Covers: one shared stream per tab (ref-counted with the poller), refetch on
 * every (re)connect, polling slowed while live and restored on a drop, frames
 * applied to the loaded panel list and the badge (with a debounced server
 * reconcile), `sync` frames, and the OS-toast decision table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../services/notifications', () => ({
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  getNotificationConfig: vi.fn(),
}));

const closeMock = vi.fn();
let capturedHandlers: {
  onEvent: (e: unknown) => void;
  onOpen: () => void;
  onStateChange?: (s: string) => void;
} | null = null;
const connectMock = vi.fn();

vi.mock('../../services/notificationStream', () => ({
  connectNotificationStream: (handlers: typeof capturedHandlers) => {
    connectMock(handlers);
    capturedHandlers = handlers;
    return { close: closeMock };
  },
}));

vi.mock('../../services/browserNotifications', () => ({
  showAppNotification: vi.fn().mockResolvedValue('sw'),
}));

vi.mock('../../services/pushSubscription', () => ({
  hasActivePushSubscription: vi.fn().mockResolvedValue(false),
}));

import {
  useNotifications,
  setNotificationOpenHandler,
  __resetNotificationsStoreForTests,
  POLL_INTERVAL_MS,
  STREAM_SAFETY_POLL_MS,
  COUNT_RECONCILE_DELAY_MS,
} from '../../hooks/useNotifications';
import {
  getNotificationConfig,
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from '../../services/notifications';
import { showAppNotification } from '../../services/browserNotifications';
import { hasActivePushSubscription } from '../../services/pushSubscription';
import type { NotificationItem } from '../../types/notifications';

const mockCount = vi.mocked(getUnreadCount);
const mockList = vi.mocked(listNotifications);
const mockMarkRead = vi.mocked(markNotificationRead);
const mockConfig = vi.mocked(getNotificationConfig);
const mockShow = vi.mocked(showAppNotification);
const mockHasPush = vi.mocked(hasActivePushSubscription);

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    circleId: 'circle-1',
    type: 'upload_completed',
    title: 'Uploaded',
    body: null,
    link: '/',
    data: null,
    readAt: null,
    dismissedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function frame(
  n: NotificationItem,
  extra: { toast?: boolean; pushed?: boolean; unreadCount?: number; reason?: string } = {},
) {
  return { type: 'notification', notification: n, toast: false, pushed: false, reason: null, ...extra };
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

function setFocus(focused: boolean): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

function setPermission(p: NotificationPermission): void {
  (window.Notification as unknown as { permission: NotificationPermission }).permission = p;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('useNotifications — live stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNotificationsStoreForTests();
    capturedHandlers = null;
    setVisibility('visible');
    setFocus(true);
    setPermission('granted');
    mockCount.mockResolvedValue(0);
    mockList.mockResolvedValue({ items: [], meta: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 } });
    mockMarkRead.mockResolvedValue(undefined);
    mockConfig.mockResolvedValue({
      pushEnabled: true,
      vapidPublicKey: 'key',
      browserEnabled: true,
      pushTypes: [],
    });
    mockHasPush.mockResolvedValue(false);
  });

  afterEach(() => {
    __resetNotificationsStoreForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connection lifecycle', () => {
    it('opens ONE stream for several subscribers and closes it with the last', async () => {
      const a = renderHook(() => useNotifications());
      const b = renderHook(() => useNotifications());
      await flush();
      expect(connectMock).toHaveBeenCalledTimes(1);

      a.unmount();
      expect(closeMock).not.toHaveBeenCalled();
      b.unmount();
      expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it('never connects for a disabled subscriber', async () => {
      renderHook(() => useNotifications({ enabled: false }));
      await flush();
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('connects even while the tab is hidden (toasts matter most there)', async () => {
      setVisibility('hidden');
      renderHook(() => useNotifications());
      await flush();
      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(mockCount).not.toHaveBeenCalled();
    });

    it('refetches the count on EVERY open, and the list when it was loaded', async () => {
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        await result.current.refreshList();
      });
      mockCount.mockClear();
      mockList.mockClear();

      await act(async () => capturedHandlers!.onOpen());
      await flush();
      expect(result.current.isLive).toBe(true);
      expect(mockCount).toHaveBeenCalledTimes(1);
      expect(mockList).toHaveBeenCalledTimes(1);

      // A reconnect is the same signal again.
      await act(async () => capturedHandlers!.onStateChange!('reconnecting'));
      expect(result.current.isLive).toBe(false);
      await act(async () => capturedHandlers!.onOpen());
      await flush();
      expect(mockCount).toHaveBeenCalledTimes(2);
    });
  });

  describe('polling cadence', () => {
    it('slows to the safety-net interval while live and restores 60s on a drop', async () => {
      vi.useFakeTimers();
      renderHook(() => useNotifications());
      await flush();
      await act(async () => capturedHandlers!.onOpen());
      await flush();
      mockCount.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
      });
      expect(mockCount).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(STREAM_SAFETY_POLL_MS - POLL_INTERVAL_MS);
      });
      expect(mockCount).toHaveBeenCalledTimes(1);

      mockCount.mockClear();
      await act(async () => capturedHandlers!.onStateChange!('reconnecting'));
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
      });
      expect(mockCount).toHaveBeenCalledTimes(1);
    });
  });

  describe('applying frames', () => {
    it('prepends a new row into a loaded list, bumps the badge, then reconciles', async () => {
      vi.useFakeTimers();
      mockCount.mockResolvedValue(2);
      mockList.mockResolvedValue({
        items: [item({ id: 'old', readAt: '2026-09-01T00:00:00.000Z' })],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      });
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        await result.current.refreshList();
      });
      expect(result.current.unreadCount).toBe(2);

      mockCount.mockClear();
      mockCount.mockResolvedValue(3);
      await act(async () => capturedHandlers!.onEvent(frame(item({ id: 'new' }))));

      expect(result.current.items.map((n) => n.id)).toEqual(['new', 'old']);
      expect(result.current.unreadCount).toBe(3);
      expect(mockCount).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(COUNT_RECONCILE_DELAY_MS);
      });
      await flush();
      expect(mockCount).toHaveBeenCalledTimes(1);
    });

    it('takes the frame\'s server-read unreadCount as exact and skips the reconcile', async () => {
      vi.useFakeTimers();
      mockCount.mockResolvedValue(4);
      const { result } = renderHook(() => useNotifications());
      await flush();
      mockCount.mockClear();

      await act(async () => capturedHandlers!.onEvent(frame(item(), { unreadCount: 9 })));
      expect(result.current.unreadCount).toBe(9);
      await act(async () => {
        vi.advanceTimersByTime(COUNT_RECONCILE_DELAY_MS * 2);
      });
      expect(mockCount).not.toHaveBeenCalled();
    });

    it('does not touch the list when the panel was never opened', async () => {
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => capturedHandlers!.onEvent(frame(item())));
      expect(result.current.items).toEqual([]);
      expect(result.current.unreadCount).toBe(1);
    });

    it('replaces an existing row in place and re-counts a read row that is unread again', async () => {
      mockCount.mockResolvedValue(0);
      mockList.mockResolvedValue({
        items: [item({ id: 'a', readAt: '2026-09-01T00:00:00.000Z', title: 'old' })],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      });
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        await result.current.refreshList();
      });

      await act(async () => capturedHandlers!.onEvent(frame(item({ id: 'a', title: 'new' }))));
      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0].title).toBe('new');
      expect(result.current.unreadCount).toBe(1);
    });

    it('counts a burst of frames for the same unseen id once', async () => {
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        capturedHandlers!.onEvent(frame(item({ id: 'x' })));
        capturedHandlers!.onEvent(frame(item({ id: 'x' })));
      });
      expect(result.current.unreadCount).toBe(1);
    });

    it('removes a row that arrives dismissed', async () => {
      mockList.mockResolvedValue({
        items: [item({ id: 'a' })],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      });
      mockCount.mockResolvedValue(1);
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        await result.current.refreshList();
      });
      await act(async () =>
        capturedHandlers!.onEvent(frame(item({ id: 'a', dismissedAt: '2026-09-02T00:00:00.000Z' }))),
      );
      expect(result.current.items).toEqual([]);
      expect(result.current.unreadCount).toBe(0);
    });

    it('a sync frame re-reads the count and a loaded list', async () => {
      const { result } = renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        await result.current.refreshList();
      });
      mockCount.mockClear();
      mockList.mockClear();
      await act(async () => capturedHandlers!.onEvent({ type: 'sync' }));
      await flush();
      expect(mockCount).toHaveBeenCalledTimes(1);
      expect(mockList).toHaveBeenCalledTimes(1);
    });
  });

  describe('toasts', () => {
    async function mountAndSend(f: ReturnType<typeof frame>) {
      renderHook(() => useNotifications());
      await flush();
      await act(async () => capturedHandlers!.onEvent(f));
      await flush();
    }

    it('raises a toast for a toast frame while the tab is hidden', async () => {
      setVisibility('hidden');
      await mountAndSend(frame(item(), { toast: true }));
      expect(mockShow).toHaveBeenCalledTimes(1);
      expect(mockShow.mock.calls[0][0].id).toBe('n1');
    });

    it('raises a toast when visible but unfocused', async () => {
      setFocus(false);
      await mountAndSend(frame(item(), { toast: true }));
      expect(mockShow).toHaveBeenCalledTimes(1);
    });

    it('stays silent when the tab is visible AND focused', async () => {
      await mountAndSend(frame(item(), { toast: true }));
      expect(mockShow).not.toHaveBeenCalled();
    });

    it('stays silent when the server did not ask for a toast', async () => {
      setFocus(false);
      await mountAndSend(frame(item(), { toast: false }));
      expect(mockShow).not.toHaveBeenCalled();
    });

    it('stays silent without granted permission', async () => {
      setFocus(false);
      setPermission('default');
      await mountAndSend(frame(item(), { toast: true }));
      expect(mockShow).not.toHaveBeenCalled();
    });

    it('defers to the service worker when pushed AND this browser holds a subscription', async () => {
      setFocus(false);
      mockHasPush.mockResolvedValue(true);
      await mountAndSend(frame(item(), { toast: true, pushed: true }));
      expect(mockHasPush).toHaveBeenCalledWith('key');
      expect(mockShow).not.toHaveBeenCalled();
    });

    it('shows its own toast when pushed but this browser has no subscription', async () => {
      setFocus(false);
      mockHasPush.mockResolvedValue(false);
      await mountAndSend(frame(item(), { toast: true, pushed: true }));
      expect(mockShow).toHaveBeenCalledTimes(1);
    });

    it('shows its own toast when pushed but the config read fails', async () => {
      setFocus(false);
      mockConfig.mockRejectedValue(new Error('boom'));
      await mountAndSend(frame(item(), { toast: true, pushed: true }));
      expect(mockShow).toHaveBeenCalledTimes(1);
    });

    it('toasts an id once, not once per re-published increment', async () => {
      setFocus(false);
      renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        capturedHandlers!.onEvent(frame(item(), { toast: true }));
        capturedHandlers!.onEvent(frame(item({ title: 'more' }), { toast: true }));
      });
      await flush();
      expect(mockShow).toHaveBeenCalledTimes(1);
    });

    it('toasts a seen id again when the frame is a reunread', async () => {
      setFocus(false);
      renderHook(() => useNotifications());
      await flush();
      await act(async () => {
        capturedHandlers!.onEvent(frame(item(), { toast: true, reason: 'created' }));
        capturedHandlers!.onEvent(frame(item(), { toast: true, reason: 'reunread' }));
      });
      await flush();
      expect(mockShow).toHaveBeenCalledTimes(2);
    });

    it('a click marks the row read and hands it to the registered open handler', async () => {
      setFocus(false);
      const open = vi.fn();
      setNotificationOpenHandler(open);
      await mountAndSend(frame(item({ id: 'clicked' }), { toast: true }));

      const onClick = mockShow.mock.calls[0][1]!;
      await act(async () => onClick(item({ id: 'clicked' })));
      expect(mockMarkRead).toHaveBeenCalledWith('clicked');
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'clicked' }));
    });
  });
});
