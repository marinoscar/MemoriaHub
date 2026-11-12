/**
 * The navigation rail — the app's binding of the packaged
 * `ShellNavigationRail` (RETRO-F1, #571; the rail is issue #392 / #402).
 *
 * Pins what `config/shell.ts` feeds it: the library destinations, the Console
 * pinned at the foot for an admin only, Console mode on `/admin/*` listing the
 * admin registry with a permanent way back, Review's badge, the collapsed /
 * expanded treatments at `lg`, the stored collapse preference, and the
 * Collections / Review context panes beside the EXPANDED rail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { NavigationRail } from '../../../components/navigation/NavigationRail';
import { renderShell } from '../../utils/shell-harness';

vi.mock('../../../components/collections/CollectionsList', () => ({
  CollectionsList: ({ activeKey }: { activeKey: string | null }) => (
    <div data-testid="collections-list">{String(activeKey)}</div>
  ),
}));
vi.mock('@marinoscar/memoriahub-web/hubs/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useReviewQueues: vi.fn(),
  ReviewQueueList: ({ activeKey }: { activeKey: string | null }) => (
    <div data-testid="review-list">{String(activeKey)}</div>
  ),
  reviewQueuePath: (key: string) => `/review/${key}`,
}));

import { useReviewQueues } from '@marinoscar/memoriahub-web/hubs/ui';
import type { UseReviewQueuesResult } from '@marinoscar/memoriahub-web/hubs/ui';

const mockUseReviewQueues = vi.mocked(useReviewQueues);

function queues(totalPending = 0): UseReviewQueuesResult {
  return { entries: [], counts: null, totalPending, isLoading: false, anyEnabled: true };
}

function mainNav() {
  return screen.getByRole('navigation', { name: /navigation/ });
}

describe('NavigationRail (packaged ShellNavigationRail binding)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseReviewQueues.mockReturnValue(queues());
  });

  it('lists the library destinations and no Console for a non-admin', () => {
    renderShell(<NavigationRail />, { width: 1280 });
    const nav = mainNav();
    expect(nav).toHaveAccessibleName('Main navigation');
    for (const label of ['Photos', 'Collections', 'Search', 'Review']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: 'Console' })).not.toBeInTheDocument();
  });

  it('pins the Console at the foot for a viewer holding system_settings:read', () => {
    renderShell(<NavigationRail />, { width: 1280, admin: true });
    expect(within(mainNav()).getByRole('link', { name: 'Console' })).toHaveAttribute(
      'href',
      '/admin/settings',
    );
  });

  it('marks the owning destination current on a route that does not resemble it (/bursts → Review)', () => {
    renderShell(<NavigationRail />, { width: 1280, route: '/bursts' });
    expect(within(mainNav()).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('carries the pending Review count in the accessible name', () => {
    mockUseReviewQueues.mockReturnValue(queues(7));
    renderShell(<NavigationRail />, { width: 1280 });
    expect(within(mainNav()).getByRole('link', { name: /Review.*7/ })).toBeInTheDocument();
  });

  it('swaps to Console mode on /admin/* when expanded, with a way back to the library', () => {
    renderShell(<NavigationRail />, { width: 1280, admin: true, route: '/admin/settings/general' });
    const nav = screen.getByRole('navigation', { name: 'Console navigation' });
    expect(within(nav).getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/');
    expect(within(nav).queryByRole('link', { name: 'Photos' })).not.toBeInTheDocument();
  });

  it('keeps library navigation in the collapsed (medium) rail on /admin/*', () => {
    renderShell(<NavigationRail />, { width: 800, admin: true, route: '/admin/settings/general' });
    const nav = mainNav();
    expect(nav).toHaveAccessibleName('Main navigation');
    expect(within(nav).getByRole('link', { name: 'Console' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers the collapse toggle only at lg and up', () => {
    const { unmount } = renderShell(<NavigationRail />, { width: 1280 });
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    unmount();
    renderShell(<NavigationRail />, { width: 800 });
    expect(screen.queryByRole('button', { name: /navigation/ })).not.toBeInTheDocument();
  });

  it('honours a stored railCollapsed preference from user_settings.navigation', async () => {
    renderShell(<NavigationRail />, {
      width: 1280,
      userSettings: { navigation: { railCollapsed: true } },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
  });

  describe('context panes (beside the expanded rail only)', () => {
    it('draws the Collections pane on a Collections route with the active entry', () => {
      renderShell(<NavigationRail />, { width: 1280, route: '/albums/a1' });
      const pane = document.querySelector('[data-shell-context-pane="collections"]');
      expect(pane).not.toBeNull();
      expect(within(pane as HTMLElement).getByTestId('collections-list')).toHaveTextContent('albums');
    });

    it('draws the Review pane on a standalone queue route (/duplicates/x)', () => {
      renderShell(<NavigationRail />, { width: 1280, route: '/duplicates/x' });
      const pane = document.querySelector('[data-shell-context-pane="review"]');
      expect(within(pane as HTMLElement).getByTestId('review-list')).toHaveTextContent('duplicates');
    });

    it.each([
      ['/', 1280],
      ['/search', 1280],
      ['/albums', 1199],
    ])('draws no pane at %s (%dpx)', (route, width) => {
      renderShell(<NavigationRail />, { width, route });
      expect(document.querySelector('[data-shell-context-pane]')).toBeNull();
    });
  });
});
