/**
 * NotificationsPage — the `/notifications` inbox (issue #250, epic #240).
 *
 * Scope note, per docs/specs/datatable.md §17.8 (mirrored from JobsPage.test.tsx,
 * the migration this page follows): TABLE MECHANICS — pagination/sort/selection
 * round-trips, loading/empty/error overlays, column visibility, the 360px
 * no-horizontal-scroll guard — are a property of the shared DataTable component
 * and are covered end-to-end by `runDataTableConformanceSuite`. None of that is
 * re-tested here.
 *
 * What IS here is everything specific to this page:
 *   - the three status tabs driving `status`,
 *   - pagination's 1-based page param,
 *   - the two bulk endpoints and their >25 confirmation threshold,
 *   - per-row open (mark read, then follow the link; the link's `?c=` switches
 *     the circle in the shell, RETRO-D3) and per-row dismiss,
 *   - loading / empty / error states,
 *   - the rendering contract (shared DataTable, no raw TableContainer).
 *
 * `useCircle` and the platform's `useNotifications` are mocked directly so each scenario can be driven with exact,
 * deterministic circle/store fixtures. `useNotificationList` is NOT mocked —
 * its only network dependency, `listNotifications`, is — so the page's own
 * fetch-on-param-change wiring is exercised for real.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
} from '@marinoscar/platform-web/datatable/testing';
import type { Circle } from '../../../types/circles';
import type { NotificationItem, NotificationListResponse } from '../../../types/notifications';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('@marinoscar/platform-web/notifications/headless', () => ({
  useNotifications: vi.fn(),
}));

vi.mock('../../../services/notifications', () => ({
  listNotifications: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import NotificationsPage, { BULK_CONFIRM_THRESHOLD } from '../../../pages/Notifications/NotificationsPage';
import { useCircle } from '../../../hooks/useCircle';
import { useNotifications } from '@marinoscar/platform-web/notifications/headless';
import { listNotifications } from '../../../services/notifications';
import { api } from '../../../services/api';

const mockUseCircle = vi.mocked(useCircle);
const mockUseNotifications = vi.mocked(useNotifications);
const mockListNotifications = vi.mocked(listNotifications);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeCircle(id: string, name: string): Circle {
  return {
    id,
    name,
    description: null,
    ownerId: 'test-user-id',
    isPersonal: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function listResponse(
  items: NotificationItem[],
  metaOverrides: Partial<NotificationListResponse['meta']> = {},
): NotificationListResponse {
  return {
    items,
    meta: { page: 1, pageSize: 25, totalItems: items.length, totalPages: 1, ...metaOverrides },
  };
}

/** The mutable spies behind the mocked `useNotifications()` return value. */
const markRead = vi.fn().mockResolvedValue(undefined);
const dismiss = vi.fn().mockResolvedValue(undefined);
const markAllRead = vi.fn().mockResolvedValue(undefined);
const dismissAll = vi.fn().mockResolvedValue(undefined);
const refresh = vi.fn().mockResolvedValue(undefined);

function setNotificationsState(
  overrides: { unreadCount?: number } = {},
): void {
  mockUseNotifications.mockReturnValue({
    notifications: [],
    unreadCount: overrides.unreadCount ?? 0,
    isLoading: false,
    error: null,
    streamState: 'open',
    refresh,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
  } as unknown as ReturnType<typeof useNotifications>);

}

/** setActiveCircle spy shared with the ordering-assertion tests. */
let setActiveCircle: ReturnType<typeof vi.fn>;
/** Records call order across the two mocked side effects, for ordering checks. */
let callOrder: string[];

function setCircleState(activeCircleId: string | null, circles: Circle[]): void {
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

/** Discriminates the shared `listNotifications` mock by call shape. */
function mockList(opts: {
  main: NotificationItem[];
  mainMeta?: Partial<NotificationListResponse['meta']>;
  /** totalItems the threshold-count call (`pageSize: 1`) should report, by status. */
  affected?: { unread?: number; all?: number };
}): void {
  mockListNotifications.mockImplementation(async (params) => {
    if (params?.pageSize === 1) {
      const total =
        params.status === 'unread' ? opts.affected?.unread ?? 0 : opts.affected?.all ?? 0;
      return listResponse([], { totalItems: total, pageSize: 1 });
    }
    return listResponse(opts.main, opts.mainMeta);
  });
}

function renderPage() {
  return render(<NotificationsPage />);
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, rowLabel: string) {
  const trigger = await screen.findByRole('button', { name: `Row actions for ${rowLabel}` });
  await user.click(trigger);
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  selectName: string | RegExp,
  optionName: string | RegExp,
) {
  const combo = await screen.findByRole('combobox', { name: selectName });
  await user.click(combo);
  const option = await screen.findByRole('option', { name: optionName });
  await user.click(option);
}

// ---------------------------------------------------------------------------

describe('NotificationsPage', () => {
  beforeAll(() => {
    // jsdom performs no layout, so MUI X measures a 0×0 viewport and renders
    // zero rows without these. Same recipe every DataTable suite uses.
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise
    callOrder = [];
    setNotificationsState({ unreadCount: 10 });
    setCircleState('circle-1', [makeCircle('circle-1', 'Home Circle')]);
    mockList({ main: [] });
        // The table's layout-persistence hook reads/writes `/user-settings`
    // (docs/specs/datatable.md §15). Stub the real `api` singleton so the page
    // goes through exactly the client it ships with, without a network call.
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Rendering contract
  // =========================================================================

  describe('Rendering contract', () => {
    it('renders through the shared DataTable, not a page-level raw table', async () => {
      renderPage();

      const table = await screen.findByTestId('datatable');
      expect(table).toBeInTheDocument();
      expect(await screen.findByRole('grid', { name: 'Notifications' })).toBeInTheDocument();
      // No page-level TableContainer — the shared component owns the table.
      expect(document.querySelector('.MuiTableContainer-root')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Status tabs
  // =========================================================================

  describe('Status tabs', () => {
    it.each([
      ['Unread', 'unread'],
      ['All', 'all'],
      ['Dismissed', 'dismissed'],
    ] as const)('the %s tab requests status=%s and renders its own row', async (tabLabel, status) => {
      const rowTitle = `${status} row`;
      mockList({ main: [makeNotification({ id: status, title: rowTitle })] });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('tab', { name: tabLabel }));

      await waitFor(() => {
        expect(mockListNotifications).toHaveBeenCalledWith(
          expect.objectContaining({ status }),
        );
      });
      expect(await screen.findByText(rowTitle)).toBeInTheDocument();
    });

    it('resets to the first page when the tab changes', async () => {
      mockList({
        main: [makeNotification({ id: 'a' })],
        mainMeta: { totalItems: 60, page: 1 },
      });
      const user = userEvent.setup();

      renderPage();
      const next = await screen.findByRole('button', { name: /go to next page/i });
      await waitFor(() => expect(next).toBeEnabled());
      await user.click(next);
      await waitFor(() => {
        expect(mockListNotifications).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2 }),
        );
      });

      await user.click(screen.getByRole('tab', { name: 'All' }));

      await waitFor(() => {
        expect(mockListNotifications).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'all', page: 1 }),
        );
      });
    });
  });

  // =========================================================================
  // Pagination
  // =========================================================================

  describe('Pagination', () => {
    it('reports a 1-based page to the API when the next page is requested', async () => {
      mockList({
        main: [makeNotification({ id: 'a' })],
        mainMeta: { totalItems: 60, page: 1, pageSize: 25 },
      });
      const user = userEvent.setup();

      renderPage();
      const next = await screen.findByRole('button', { name: /go to next page/i });
      await waitFor(() => expect(next).toBeEnabled());
      await user.click(next);

      await waitFor(() => {
        expect(mockListNotifications).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2, pageSize: 25 }),
        );
      });
    });
  });

  // =========================================================================
  // Bulk actions — basic
  // =========================================================================

  describe('Bulk actions', () => {
    it('"Mark all as read" hits the bulk read-all endpoint when the affected count is small', async () => {
      mockList({ main: [], affected: { unread: 3 } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

      await waitFor(() => {
        expect(markAllRead).toHaveBeenCalled();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('"Dismiss all" hits the bulk dismiss-all endpoint when the affected count is small', async () => {
      mockList({ main: [], affected: { all: 3 } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Dismiss all' }));

      await waitFor(() => {
        expect(dismissAll).toHaveBeenCalled();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows an info snackbar and performs no mutation when nothing is affected', async () => {
      mockList({ main: [], affected: { unread: 0 } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

      expect(await screen.findByText(/nothing left to mark as read/i)).toBeInTheDocument();
      expect(markAllRead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // >25 bulk confirmation threshold — the case the issue specifically asks for
  // =========================================================================

  describe('Bulk confirmation threshold', () => {
    it(`fires directly with no confirm dialog when affected === ${BULK_CONFIRM_THRESHOLD} (at the threshold)`, async () => {
      mockList({ main: [], affected: { unread: BULK_CONFIRM_THRESHOLD } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

      await waitFor(() => {
        expect(markAllRead).toHaveBeenCalled();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it(`confirms before firing when affected === ${BULK_CONFIRM_THRESHOLD + 1} (over the threshold)`, async () => {
      mockList({ main: [], affected: { unread: BULK_CONFIRM_THRESHOLD + 1 } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(`Mark ${BULK_CONFIRM_THRESHOLD + 1} notifications as read?`),
      ).toBeInTheDocument();
      // Not fired yet — waiting on the user's confirmation.
      expect(markAllRead).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Mark all as read' }));

      await waitFor(() => {
        expect(markAllRead).toHaveBeenCalled();
      });
    });

    it('cancelling the confirm dialog performs no mutation', async () => {
      mockList({ main: [], affected: { unread: BULK_CONFIRM_THRESHOLD + 1 } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(markAllRead).not.toHaveBeenCalled();
    });

    it('also confirms "Dismiss all" over the threshold', async () => {
      mockList({ main: [], affected: { all: BULK_CONFIRM_THRESHOLD + 5 } });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('button', { name: 'Dismiss all' }));

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(`Dismiss ${BULK_CONFIRM_THRESHOLD + 5} notifications?`),
      ).toBeInTheDocument();
      expect(dismissAll).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Dismiss all' }));

      await waitFor(() => {
        expect(dismissAll).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Per-row open — circle-switch-then-navigate (same contract as the bell)
  // =========================================================================

  describe('Opening a notification row', () => {
    it('follows the link (carrying ?c=<circleId>) without switching the circle itself', async () => {
      const item = makeNotification({
        id: 'x',
        title: 'Switch target',
        circleId: 'circle-2',
        link: '/bursts?c=circle-2',
        readAt: '2026-08-01T00:00:00.000Z',
      });
      mockList({ main: [item] });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByText('Switch target'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/bursts?c=circle-2');
      });
      expect(setActiveCircle).not.toHaveBeenCalled();
    });

    it('does not navigate to an external link', async () => {
      const item = makeNotification({ id: 'ext', title: 'External target', link: 'https://example.test/x' });
      mockList({ main: [item] });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByText('External target'));

      expect(markRead).toHaveBeenCalledWith('ext');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('marks an unread notification read when opened', async () => {
      const item = makeNotification({ id: 'unread-open', title: 'Unread target', readAt: null });
      mockList({ main: [item] });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByText('Unread target'));

      expect(markRead).toHaveBeenCalledWith('unread-open');
    });

    it('does not call markRead for an already-read notification', async () => {
      const item = makeNotification({
        id: 'already-read',
        title: 'Already read target',
        readAt: '2026-08-01T00:00:00.000Z',
      });
      mockList({ main: [item] });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByText('Already read target'));

      expect(markRead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Per-row dismiss — removes the row, never navigates
  // =========================================================================

  describe('Dismissing a notification row', () => {
    it('calls dismiss() for the row, removes it from the table, and does NOT navigate', async () => {
      const item = makeNotification({ id: 'dismiss-me', title: 'Dismiss target', link: '/bursts' });
      let currentItems = [item];
      mockListNotifications.mockImplementation(async (params) => {
        if (params?.pageSize === 1) return listResponse([], { totalItems: 0 });
        return listResponse(currentItems);
      });
      dismiss.mockImplementation(async (id: string) => {
        currentItems = currentItems.filter((n) => n.id !== id);
      });
      const user = userEvent.setup();

      renderPage();
      expect(await screen.findByText('Dismiss target')).toBeInTheDocument();

      await openRowMenu(user, 'Dismiss target');
      await user.click(await screen.findByRole('menuitem', { name: 'Dismiss' }));

      expect(dismiss).toHaveBeenCalledWith('dismiss-me');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(markRead).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.queryByText('Dismiss target')).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Loading / empty / error states
  // =========================================================================

  describe('States', () => {
    it('shows the loading overlay while the list request is in flight', async () => {
      mockListNotifications.mockImplementation(() => new Promise(() => {})); // never resolves

      renderPage();

      expect(await screen.findByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });

    it('shows the tab-specific empty state when there are zero rows', async () => {
      mockList({ main: [] });

      renderPage();

      expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    });

    it('shows the "All" tab empty state after switching tabs', async () => {
      mockList({ main: [] });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('tab', { name: 'All' }));

      expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    });

    it('shows the "Dismissed" tab empty state after switching tabs', async () => {
      mockList({ main: [] });
      const user = userEvent.setup();

      renderPage();
      await user.click(screen.getByRole('tab', { name: 'Dismissed' }));

      expect(await screen.findByText('Nothing dismissed')).toBeInTheDocument();
    });

    it('surfaces a load failure through the table error slot', async () => {
      mockListNotifications.mockRejectedValue(new Error('Notifications load failed'));

      renderPage();

      expect(await screen.findByTestId('datatable-error')).toHaveTextContent(
        /notifications load failed/i,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Pure filter-model → circle-scope mapping (notificationsTable.ts)
// ---------------------------------------------------------------------------
