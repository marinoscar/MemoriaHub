/**
 * Tests for NotificationPanel (issue #249).
 *
 * `useNotifications` and `useCircle` are mocked directly (same pattern as
 * BurstsPage.test.tsx / DuplicateGroupPage.test.tsx) so each scenario can be
 * driven with exact, deterministic item/circle fixtures — the store's own
 * behavior (optimistic updates, rollback, polling) is covered separately in
 * `hooks/useNotifications.test.ts` and `NotificationBell.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import type { Circle } from '../../../types/circles';
import type { NotificationItem } from '../../../types/notifications';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useNotifications', () => ({
  useNotifications: vi.fn(),
}));

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { NotificationPanel } from '../../../components/notifications/NotificationPanel';
import { useNotifications } from '../../../hooks/useNotifications';
import { useCircle } from '../../../hooks/useCircle';

const mockUseNotifications = vi.mocked(useNotifications);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeCircle(id: string, overrides: Partial<Circle> = {}): Circle {
  return {
    id,
    name: `Circle ${id}`,
    description: null,
    ownerId: 'test-user-id',
    isPersonal: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const markRead = vi.fn().mockResolvedValue(undefined);
const dismiss = vi.fn().mockResolvedValue(undefined);
const markAllRead = vi.fn().mockResolvedValue(undefined);
const refreshList = vi.fn().mockResolvedValue(undefined);
const refreshCount = vi.fn().mockResolvedValue(undefined);

function setNotificationsState(overrides: {
  items?: NotificationItem[];
  unreadCount?: number;
  isLoading?: boolean;
  hasLoadedList?: boolean;
  error?: string | null;
} = {}) {
  mockUseNotifications.mockReturnValue({
    unreadCount: overrides.unreadCount ?? 0,
    items: overrides.items ?? [],
    isLoading: overrides.isLoading ?? false,
    hasLoadedList: overrides.hasLoadedList ?? true,
    error: overrides.error ?? null,
    refreshList,
    refreshCount,
    markRead,
    dismiss,
    markAllRead,
  });
}

/** setActiveCircle spy shared with the ordering-assertion tests. */
let setActiveCircle: ReturnType<typeof vi.fn>;
/** Records call order across the two mocked side effects, for ordering checks. */
let callOrder: string[];

function setCircleState(activeCircleId: string | null, circles: Circle[]) {
  setActiveCircle = vi.fn().mockImplementation(async (id: string) => {
    callOrder.push(`setActiveCircle:${id}`);
  });
  mockUseCircle.mockReturnValue({
    circles,
    activeCircle: circles.find((c) => c.id === activeCircleId) ?? null,
    activeCircleId,
    activeCircleRole: 'collaborator',
    loading: false,
    setActiveCircle,
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

function renderPanel(open = true) {
  return render(
    <NotificationPanel open={open} anchorEl={null} onClose={vi.fn()} />,
  );
}

describe('NotificationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder = [];
    setNotificationsState();
    setCircleState('circle-1', [makeCircle('circle-1')]);
    mockNavigate.mockImplementation((to: string) => {
      callOrder.push(`navigate:${to}`);
    });
  });

  // =========================================================================
  // Panel states
  // =========================================================================

  describe('states', () => {
    it('shows the empty state when the list has loaded with zero items', () => {
      setNotificationsState({ items: [], hasLoadedList: true });
      renderPanel();

      expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    });

    it('shows a loading skeleton before the first list fetch resolves', () => {
      setNotificationsState({ hasLoadedList: false });
      renderPanel();

      expect(screen.getByTestId('notification-panel-skeleton')).toBeInTheDocument();
      expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    });

    it('shows an error alert when the store reports an error', () => {
      setNotificationsState({ hasLoadedList: true, error: 'Failed to load notifications' });
      renderPanel();

      expect(screen.getByRole('alert')).toHaveTextContent('Failed to load notifications');
    });

    it('renders each notification row when items are present', () => {
      setNotificationsState({
        hasLoadedList: true,
        items: [
          makeNotification({ id: 'a', title: 'First notification' }),
          makeNotification({ id: 'b', title: 'Second notification' }),
        ],
      });
      renderPanel();

      expect(screen.getByText('First notification')).toBeInTheDocument();
      expect(screen.getByText('Second notification')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Dismiss: removes the row, never navigates
  // =========================================================================

  describe('dismiss', () => {
    it('calls dismiss() for the row and does NOT navigate', async () => {
      const user = userEvent.setup();
      const item = makeNotification({ id: 'dismiss-me', title: 'Dismiss target', link: '/bursts' });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      renderPanel();

      const dismissButton = screen.getByRole('button', {
        name: 'Dismiss notification: Dismiss target',
      });
      await user.click(dismissButton);

      expect(dismiss).toHaveBeenCalledWith('dismiss-me');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(markRead).not.toHaveBeenCalled();
      expect(setActiveCircle).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Mark all as read
  // =========================================================================

  describe('mark all as read', () => {
    it('hits the bulk endpoint (unscoped) when clicked', async () => {
      const user = userEvent.setup();
      setNotificationsState({
        hasLoadedList: true,
        unreadCount: 2,
        items: [makeNotification({ id: 'a' }), makeNotification({ id: 'b' })],
      });
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

      expect(markAllRead).toHaveBeenCalledTimes(1);
      expect(markAllRead).toHaveBeenCalledWith();
    });

    it('is disabled when unreadCount is 0', () => {
      setNotificationsState({ hasLoadedList: true, unreadCount: 0, items: [] });
      renderPanel();

      expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
    });
  });

  // =========================================================================
  // Circle-switch-then-navigate
  // =========================================================================

  describe('opening a notification row', () => {
    it('switches the active circle BEFORE navigating when the notification targets a different, known circle', async () => {
      const user = userEvent.setup();
      const item = makeNotification({
        id: 'x',
        title: 'Switch target',
        circleId: 'circle-2',
        link: '/bursts',
        readAt: '2026-08-01T00:00:00.000Z', // already read — isolates ordering from markRead
      });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      setCircleState('circle-1', [makeCircle('circle-1'), makeCircle('circle-2')]);
      renderPanel();

      await user.click(screen.getByText('Switch target'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/bursts');
      });
      expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
      expect(callOrder).toEqual(['setActiveCircle:circle-2', 'navigate:/bursts']);
    });

    it('does NOT switch circles when the notification circle matches the active circle', async () => {
      const user = userEvent.setup();
      const item = makeNotification({
        id: 'same',
        title: 'Same circle target',
        circleId: 'circle-1',
        link: '/bursts',
      });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      setCircleState('circle-1', [makeCircle('circle-1')]);
      renderPanel();

      await user.click(screen.getByText('Same circle target'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/bursts');
      });
      expect(setActiveCircle).not.toHaveBeenCalled();
    });

    it('does NOT switch when the notification circle is not in the membership list (membership guard)', async () => {
      const user = userEvent.setup();
      const item = makeNotification({
        id: 'gone',
        title: 'Stale circle target',
        circleId: 'circle-999',
        link: '/bursts',
      });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      // A loaded, non-empty circle list that does NOT contain circle-999.
      setCircleState('circle-1', [makeCircle('circle-1'), makeCircle('circle-2')]);
      renderPanel();

      await user.click(screen.getByText('Stale circle target'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/bursts');
      });
      expect(setActiveCircle).not.toHaveBeenCalled();
    });

    it('navigates without switching for a global (circleId: null) notification', async () => {
      const user = userEvent.setup();
      const item = makeNotification({
        id: 'global',
        title: 'Global notice',
        circleId: null,
        link: '/admin/settings/jobs',
      });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      renderPanel();

      await user.click(screen.getByText('Global notice'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/jobs');
      });
      expect(setActiveCircle).not.toHaveBeenCalled();
    });

    it('marks an unread notification read when opened', async () => {
      const user = userEvent.setup();
      const item = makeNotification({ id: 'unread-open', title: 'Unread target', readAt: null });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      renderPanel();

      await user.click(screen.getByText('Unread target'));

      expect(markRead).toHaveBeenCalledWith('unread-open');
    });

    it('does not call markRead for an already-read notification', async () => {
      const user = userEvent.setup();
      const item = makeNotification({
        id: 'already-read',
        title: 'Already read target',
        readAt: '2026-08-01T00:00:00.000Z',
      });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      renderPanel();

      await user.click(screen.getByText('Already read target'));

      expect(markRead).not.toHaveBeenCalled();
    });

    it('does not navigate when the notification has no link', async () => {
      const user = userEvent.setup();
      const item = makeNotification({ id: 'no-link', title: 'Informational only', link: null });
      setNotificationsState({ hasLoadedList: true, items: [item] });
      renderPanel();

      await user.click(screen.getByText('Informational only'));

      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Mobile variant
  // =========================================================================

  describe('responsive shell', () => {
    function setViewport(matches: (query: string) => boolean) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: matches(query),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }

    it('renders as a bottom Drawer below the sm breakpoint', () => {
      const originalMatchMedia = window.matchMedia;
      // MUI's `down('sm')` compiles to a max-width media query.
      setViewport((query) => query.includes('max-width'));
      setNotificationsState({ hasLoadedList: true, items: [] });

      try {
        renderPanel();

        expect(document.querySelector('.MuiDrawer-root')).toBeInTheDocument();
        expect(document.querySelector('.MuiPopover-root')).not.toBeInTheDocument();
        expect(screen.getByRole('presentation')).toBeInTheDocument();
      } finally {
        Object.defineProperty(window, 'matchMedia', { writable: true, value: originalMatchMedia });
      }
    });

    it('renders as an anchored Popover at sm and up', () => {
      const originalMatchMedia = window.matchMedia;
      setViewport(() => false); // jsdom default: no query ever matches
      setNotificationsState({ hasLoadedList: true, items: [] });

      try {
        renderPanel();

        expect(document.querySelector('.MuiPopover-root')).toBeInTheDocument();
        expect(document.querySelector('.MuiDrawer-root')).not.toBeInTheDocument();
      } finally {
        Object.defineProperty(window, 'matchMedia', { writable: true, value: originalMatchMedia });
      }
    });
  });
});
