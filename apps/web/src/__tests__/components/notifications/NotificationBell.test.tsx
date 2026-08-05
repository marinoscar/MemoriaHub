/**
 * Tests for NotificationBell (issue #249).
 *
 * These render the REAL `useNotifications` hook (module store) and the REAL
 * NotificationPanel it mounts — only the network seam (`services/notifications`)
 * is mocked — so the badge-decrement-then-rollback assertions exercise the
 * actual optimistic-update code path, not a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Mock the notifications service — the only network seam of the real store.
// ---------------------------------------------------------------------------
vi.mock('../../../services/notifications', () => ({
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

import { NotificationBell } from '../../../components/notifications/NotificationBell';
import { __resetNotificationsStoreForTests } from '../../../hooks/useNotifications';
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from '../../../services/notifications';
import type { NotificationItem } from '../../../types/notifications';

const mockGetUnreadCount = vi.mocked(getUnreadCount);
const mockListNotifications = vi.mocked(listNotifications);
const mockMarkNotificationRead = vi.mocked(markNotificationRead);

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notif-1',
    circleId: 'circle-1', // matches the default active circle from test-utils
    type: 'review_queue_bursts',
    title: 'Burst review ready',
    body: null,
    link: '/bursts',
    data: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetNotificationsStoreForTests();
    mockListNotifications.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
    });
    mockMarkNotificationRead.mockResolvedValue(undefined);
  });

  afterEach(() => {
    __resetNotificationsStoreForTests();
  });

  // =========================================================================
  // Badge rendering
  // =========================================================================

  describe('badge', () => {
    it('renders the unread count from GET /api/notifications/unread-count', async () => {
      mockGetUnreadCount.mockResolvedValue(5);

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });
      // Filled bell icon is shown once there is at least one unread item.
      expect(screen.getByTestId('NotificationsIcon')).toBeInTheDocument();
    });

    it('renders no visible badge digit when unread count is zero', async () => {
      mockGetUnreadCount.mockResolvedValue(0);

      render(<NotificationBell />);

      await waitFor(() => {
        expect(mockGetUnreadCount).toHaveBeenCalled();
      });

      // NOTE on why this doesn't assert `queryByText('0')` is absent: MUI's
      // <Badge> intentionally keeps the LAST rendered digit as a text node
      // (wrapped `aria-hidden`, `MuiBadge-invisible`, `transform: scale(0)`)
      // so it can animate out rather than vanish instantly — this is true in
      // a real browser too, not a jsdom artifact, and reproduces here even on
      // a fresh 0-count mount because `useBadge`'s `usePreviousProps` ref is
      // populated by the SAME render's effect before `invisible` is
      // re-evaluated. So a plain text-presence query is the wrong tool for
      // this assertion regardless of environment. The two DOM signals that
      // are actually authoritative for "no visible unread digit" are: (1) the
      // badge span carries `MuiBadge-invisible` + `aria-hidden="true"`, and
      // (2) the icon button's accessible name — computed straight from
      // `unreadCount`, unaffected by Badge's internal retained-props quirk.
      const badgeSpan = document.querySelector('.MuiBadge-badge');
      expect(badgeSpan).toHaveClass('MuiBadge-invisible');
      expect(badgeSpan).toHaveAttribute('aria-hidden', 'true');
      // Outline bell icon (no unread) is shown instead of the filled one.
      expect(screen.getByTestId('NotificationsNoneIcon')).toBeInTheDocument();
      expect(screen.queryByTestId('NotificationsIcon')).not.toBeInTheDocument();
    });

    it('embeds the unread count in the accessible name for screen readers', async () => {
      mockGetUnreadCount.mockResolvedValue(3);

      render(<NotificationBell />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Notifications, 3 unread' }),
        ).toBeInTheDocument();
      });
    });

    it('accessible name reads "no unread" when the count is zero', async () => {
      mockGetUnreadCount.mockResolvedValue(0);

      render(<NotificationBell />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Notifications, no unread' }),
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Optimistic mark-read + rollback, exercised end-to-end through the bell
  // =========================================================================

  describe('tapping a row', () => {
    it('marks it read and decrements the badge IMMEDIATELY, before the server responds', async () => {
      const user = userEvent.setup();
      const item = makeNotification();
      mockGetUnreadCount.mockResolvedValue(1);
      mockListNotifications.mockResolvedValue({
        items: [item],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      });

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      // Open the bell — this triggers refreshList().
      await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
      await waitFor(() => {
        expect(screen.getByText('Burst review ready')).toBeInTheDocument();
      });

      // The mark-read request never resolves during this test — we want to
      // observe the state BEFORE the server responds.
      let resolveRead!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveRead = resolve;
      });
      mockMarkNotificationRead.mockReturnValue(pending);

      await user.click(screen.getByText('Burst review ready'));

      // Badge dropped to 0 IMMEDIATELY — no network round-trip has completed
      // yet (`pending` is still unresolved). Asserted via the icon button's
      // accessible name, which is derived straight from `unreadCount` and is
      // unaffected by MUI Badge's animate-out digit-retention quirk (see the
      // note in the "renders no visible badge digit" test above).
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Notifications, no unread' }),
        ).toBeInTheDocument();
      });
      expect(mockMarkNotificationRead).toHaveBeenCalledWith(item.id);

      // Let the request settle so nothing leaks into the next test.
      mockGetUnreadCount.mockResolvedValue(0);
      await act(async () => {
        resolveRead();
        await pending;
      });
    });

    it('ROLLS BACK the badge to its previous value when the mark-read request fails', async () => {
      const user = userEvent.setup();
      const item = makeNotification();
      mockGetUnreadCount.mockResolvedValue(1);
      mockListNotifications.mockResolvedValue({
        items: [item],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      });

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
      await waitFor(() => {
        expect(screen.getByText('Burst review ready')).toBeInTheDocument();
      });

      let rejectRead!: (err: unknown) => void;
      const pending = new Promise<void>((_resolve, reject) => {
        rejectRead = reject;
      });
      mockMarkNotificationRead.mockReturnValue(pending);

      await user.click(screen.getByText('Burst review ready'));

      // Optimistic drop happened first.
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Notifications, no unread' }),
        ).toBeInTheDocument();
      });

      // The rollback path re-fetches the count as a tiebreaker; keep it
      // reporting the true (still-unread) value so the rollback is visible.
      mockGetUnreadCount.mockResolvedValue(1);

      await act(async () => {
        rejectRead(new Error('server exploded'));
        await pending.catch(() => undefined);
      });

      // Badge is restored to 1 — the failed mutation was rolled back.
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Notifications, 1 unread' }),
        ).toBeInTheDocument();
      });
    });
  });
});
