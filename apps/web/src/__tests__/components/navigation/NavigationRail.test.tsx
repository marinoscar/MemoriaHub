/**
 * Tests for `NavigationRail` (issue #392, epic #388, spec §4.2 / §4.3 / §7).
 *
 * `usePermissions`, `useReviewQueues`, and `useNavigationPrefs` /
 * `usePinnedDestinations` are mocked directly so each case can drive the
 * rail's chrome without touching the network. `visibleAdminSections` (Console
 * mode's contents) is exercised for real, against the live `ADMIN_SECTIONS`
 * catalog, mirroring `Sidebar.test.tsx`'s established pattern.
 *
 * The rail distinguishes COLLAPSED (below `lg`) from EXPANDED (desktop,
 * `≥ lg`) via its OWN internal `useMediaQuery(theme.breakpoints.up('lg'))` —
 * unaffected by issue #402, which only changed WHETHER the rail mounts at all
 * (`Layout`'s gate, moved from `up('md')` to `up('sm')`), never this
 * collapsed/expanded split. This file mounts `<NavigationRail />` directly
 * (not through `Layout`), and drives that distinction with the same
 * `matchMedia` viewport technique `AppBar.test.tsx` and
 * `CollectionsHubPage.test.tsx` already use. `TABLET_WIDTH` below is any width
 * under `lg` — it no longer needs to be >= `md`/900, since `Layout` no longer
 * gates the rail's mount on `md` either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { NavigationRail } from '../../../components/navigation/NavigationRail';
import { ADMIN_SECTIONS } from '../../../config/adminSections';
import type { UseReviewQueuesResult } from '../../../hooks/useReviewQueues';
import type { PinnableDestination } from '../../../hooks/useNavigationPrefs';
import StarIcon from '@mui/icons-material/Star';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));
vi.mock('../../../hooks/useReviewQueues', () => ({
  useReviewQueues: vi.fn(),
}));
vi.mock('../../../hooks/useNavigationPrefs', () => ({
  useNavigationPrefs: vi.fn(),
  usePinnedDestinations: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';
import { useReviewQueues } from '../../../hooks/useReviewQueues';
import { useNavigationPrefs, usePinnedDestinations } from '../../../hooks/useNavigationPrefs';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseReviewQueues = vi.mocked(useReviewQueues);
const mockUseNavigationPrefs = vi.mocked(useNavigationPrefs);
const mockUsePinnedDestinations = vi.mocked(usePinnedDestinations);

// ---------------------------------------------------------------------------
// Viewport helper — same technique as AppBar.test.tsx / CollectionsHubPage.test.tsx
// ---------------------------------------------------------------------------

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const min = query.match(/min-width:\s*([\d.]+)px/);
      const max = query.match(/max-width:\s*([\d.]+)px/);
      let matches = true;
      if (min) matches = matches && px >= parseFloat(min[1]);
      if (max) matches = matches && px <= parseFloat(max[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function restoreDefaultViewport() {
  // setup.ts's baseline: every query reports `matches: false` — collapsed
  // (tablet-shaped), which is the correct default since `NavigationRail`
  // itself does not gate on `md` (that's `Layout`'s job).
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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

const TABLET_WIDTH = 950; // any width < lg(1200) -> collapsed rail (this component's own gate is `up('lg')` only; the md/900 boundary belongs to `Layout`, not here — see issue #402)
const DESKTOP_WIDTH = 1300; // >= lg -> expanded rail

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function permissions(overrides: { isAdmin?: boolean; hasPermission?: (p: string) => boolean } = {}) {
  const { isAdmin = false, hasPermission = () => true } = overrides;
  return { permissions: new Set(), roles: new Set(), hasPermission, hasAnyPermission: vi.fn(), hasAllPermissions: vi.fn(), hasRole: vi.fn(), hasAnyRole: vi.fn(), isAdmin };
}

function setNonAdmin() {
  mockUsePermissions.mockReturnValue(permissions());
}

function setAdmin() {
  mockUsePermissions.mockReturnValue(permissions({ isAdmin: true, hasPermission: () => true }));
}

function reviewQueues(overrides: Partial<UseReviewQueuesResult> = {}): UseReviewQueuesResult {
  return {
    entries: [],
    counts: null,
    totalPending: 0,
    isLoading: false,
    anyEnabled: true,
    ...overrides,
  };
}

function pinnedEntry(key: string, label: string, path: string): PinnableDestination {
  return {
    key: key as PinnableDestination['key'],
    label,
    path,
    Icon: StarIcon,
    parent: 'collections',
    collectionKey: null,
    reviewKey: null,
  };
}

function setNavPrefs(overrides: Partial<ReturnType<typeof useNavigationPrefs>> = {}) {
  mockUseNavigationPrefs.mockReturnValue({
    pinned: [],
    railCollapsed: false,
    toggleRailCollapsed: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    isPinned: vi.fn(() => false),
    canPin: true,
    isLoading: false,
    ...overrides,
  });
}

describe('NavigationRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreDefaultViewport();
    setNonAdmin();
    mockUseReviewQueues.mockReturnValue(reviewQueues());
    setNavPrefs();
    mockUsePinnedDestinations.mockReturnValue([]);
  });

  afterEach(() => {
    restoreDefaultViewport();
  });

  // =========================================================================
  // Landmark + accessible name
  // =========================================================================

  describe('landmark', () => {
    it('is a <nav> with the accessible name "Main navigation" in Library mode', () => {
      render(<NavigationRail />);

      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      expect(nav.tagName).toBe('NAV');
    });

    it('is named "Console navigation" in Console mode (admin, expanded, /admin/*)', () => {
      setAdmin();
      setViewportWidth(DESKTOP_WIDTH);

      render(<NavigationRail />, { wrapperOptions: { route: '/admin/settings/jobs' } });

      expect(screen.getByRole('navigation', { name: 'Console navigation' })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // aria-current="page" — only the active row carries it, pins never do
  // =========================================================================

  describe('aria-current', () => {
    it('marks Photos active at / and no other destination row', () => {
      render(<NavigationRail />, { wrapperOptions: { route: '/' } });

      const photos = screen.getByRole('link', { name: 'Photos' });
      expect(photos).toHaveAttribute('aria-current', 'page');

      const collections = screen.getByRole('link', { name: 'Collections' });
      expect(collections).not.toHaveAttribute('aria-current');
    });

    it('marks Review active at a route it owns (/bursts) via resolveActiveDestination', () => {
      render(<NavigationRail />, { wrapperOptions: { route: '/bursts' } });

      const review = screen.getByRole('link', { name: 'Review' });
      expect(review).toHaveAttribute('aria-current', 'page');
    });

    it('a pinned row never carries aria-current, even when it points at the active route', () => {
      setViewportWidth(DESKTOP_WIDTH);
      setNavPrefs({ pinned: ['albums'] as never });
      mockUsePinnedDestinations.mockReturnValue([pinnedEntry('albums', 'Albums', '/albums')]);

      render(<NavigationRail />, { wrapperOptions: { route: '/albums' } });

      // Two "Albums"-shaped things could exist here (the Collections
      // destination row via a different label, and the pin) — assert
      // specifically that the PIN row (found by its own accessible name) has
      // no aria-current; the Collections destination row carries it instead.
      const albumsPin = screen.getByRole('link', { name: 'Albums' });
      expect(albumsPin).not.toHaveAttribute('aria-current');
      const collections = screen.getByRole('link', { name: 'Collections' });
      expect(collections).toHaveAttribute('aria-current', 'page');
    });
  });

  // =========================================================================
  // Collapsed (tablet) — full label still reaches assistive technology
  // =========================================================================

  describe('collapsed treatment (below lg — this component\'s own internal split)', () => {
    it('shows an abbreviated visible label but the FULL label as the accessible name', () => {
      render(<NavigationRail />);

      const link = screen.getByRole('link', { name: 'Collections' });
      // The visible text inside the row is the abbreviated compactLabel, not
      // the full accessible name.
      expect(within(link).getByText('Collect')).toBeInTheDocument();
      expect(within(link).queryByText('Collections')).not.toBeInTheDocument();
    });

    it('has no collapse toggle at tablet width — the preference is a desktop-only affordance', () => {
      render(<NavigationRail />);

      expect(
        screen.queryByRole('button', { name: /collapse navigation|expand navigation/i }),
      ).not.toBeInTheDocument();
    });

    it('renders no PINNED group at tablet width, even with pins present', () => {
      setNavPrefs({ pinned: ['albums'] as never });
      mockUsePinnedDestinations.mockReturnValue([pinnedEntry('albums', 'Albums', '/albums')]);

      render(<NavigationRail />);

      expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
      // The pin row itself never renders when collapsed — the group needs a
      // heading, and a heading has no room in 56px.
      expect(screen.queryByRole('link', { name: 'Albums' })).not.toBeInTheDocument();
    });

    it('Console mode does NOT trigger at tablet width even for an admin on /admin/* — Library nav stays, with Console marked active', () => {
      setAdmin();

      render(<NavigationRail />, { wrapperOptions: { route: '/admin/settings/jobs' } });

      expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Photos' })).toBeInTheDocument();
      expect(screen.queryByText('Job Queue')).not.toBeInTheDocument();

      const console = screen.getByRole('link', { name: 'Console' });
      expect(console).toHaveAttribute('aria-current', 'page');
    });
  });

  // =========================================================================
  // Expanded (desktop) — labels visible, collapse toggle present
  // =========================================================================

  describe('expanded treatment (desktop, >= lg)', () => {
    beforeEach(() => setViewportWidth(DESKTOP_WIDTH));

    it('shows the full label as visible text', () => {
      render(<NavigationRail />);

      const link = screen.getByRole('link', { name: 'Collections' });
      expect(within(link).getByText('Collections')).toBeInTheDocument();
    });

    it('renders a real <button> collapse toggle with aria-expanded', () => {
      render(<NavigationRail />);

      const toggle = screen.getByRole('button', { name: 'Collapse navigation' });
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('clicking the toggle calls toggleRailCollapsed', async () => {
      const toggleRailCollapsed = vi.fn();
      setNavPrefs({ toggleRailCollapsed });
      const user = userEvent.setup();

      render(<NavigationRail />);
      await user.click(screen.getByRole('button', { name: 'Collapse navigation' }));

      expect(toggleRailCollapsed).toHaveBeenCalledTimes(1);
    });

    it('renders a PINNED group below a divider when pins are present', () => {
      setNavPrefs({ pinned: ['albums', 'bursts'] as never });
      mockUsePinnedDestinations.mockReturnValue([
        pinnedEntry('albums', 'Albums', '/albums'),
        pinnedEntry('bursts', 'Bursts', '/review/bursts'),
      ]);

      render(<NavigationRail />);

      expect(screen.getByText('Pinned')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '/albums');
      expect(screen.getByRole('link', { name: 'Bursts' })).toHaveAttribute('href', '/review/bursts');
    });

    it('renders exactly 6 pinned rows when 6 are resolved — the cap boundary', () => {
      const sixKeys = ['a', 'b', 'c', 'd', 'e', 'f'];
      setNavPrefs({ pinned: sixKeys as never });
      mockUsePinnedDestinations.mockReturnValue(
        sixKeys.map((k) => pinnedEntry(k, `Pin ${k}`, `/${k}`)),
      );

      render(<NavigationRail />);

      for (const k of sixKeys) {
        expect(screen.getByRole('link', { name: `Pin ${k}` })).toBeInTheDocument();
      }
    });

    it('renders no PINNED group when nothing is pinned', () => {
      render(<NavigationRail />);

      expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    });

    it('Console mode swaps the rail contents at /admin/* for an admin: sections/cards render, Library rows do not', () => {
      setAdmin();

      render(<NavigationRail />, { wrapperOptions: { route: '/admin/settings/jobs' } });

      expect(screen.getByText('Back to library')).toBeInTheDocument();
      for (const section of ADMIN_SECTIONS) {
        expect(screen.getByText(section.label)).toBeInTheDocument();
      }
      expect(screen.getByText('Job Queue')).toBeInTheDocument();

      expect(screen.queryByRole('link', { name: 'Photos' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Collections' })).not.toBeInTheDocument();
    });

    it('a non-admin never sees Console mode, even on an /admin/* route', () => {
      setNonAdmin();

      render(<NavigationRail />, { wrapperOptions: { route: '/admin/settings/jobs' } });

      expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
      expect(screen.queryByText('Back to library')).not.toBeInTheDocument();
    });

    it('Console appears at the foot of Library mode only for an admin', () => {
      setAdmin();
      render(<NavigationRail />, { wrapperOptions: { route: '/' } });
      expect(screen.getByRole('link', { name: 'Console' })).toHaveAttribute('href', '/admin/settings');
    });

    it('Console never appears for a non-admin', () => {
      setNonAdmin();
      render(<NavigationRail />, { wrapperOptions: { route: '/' } });
      expect(screen.queryByRole('link', { name: 'Console' })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Review's badge/accessible name carries the count at BOTH treatments
  // =========================================================================

  describe('Review badge and accessible name', () => {
    it('includes the pending count in the accessible name when collapsed (tablet)', () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 12 }));

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Review, 12 items pending' })).toBeInTheDocument();
    });

    it('includes the pending count in the accessible name when expanded (desktop)', () => {
      setViewportWidth(DESKTOP_WIDTH);
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 12 }));

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Review, 12 items pending' })).toBeInTheDocument();
    });

    it('carries no count phrase when pending is zero, at either treatment', () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 0 }));
      const { unmount } = render(<NavigationRail />);
      expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
      unmount();

      setViewportWidth(DESKTOP_WIDTH);
      render(<NavigationRail />);
      expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
    });

    it('renders Review unconditionally even when pending is zero (spec §6.3 — never hidden)', () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 0, entries: [] }));

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Search is absent from the rail at both treatments — do not "fix" this
  // =========================================================================

  describe('Search is absent from the rail', () => {
    it('at tablet width', () => {
      render(<NavigationRail />);
      expect(screen.queryByRole('link', { name: /search/i })).not.toBeInTheDocument();
    });

    it('at desktop width', () => {
      setViewportWidth(DESKTOP_WIDTH);
      render(<NavigationRail />);
      expect(screen.queryByRole('link', { name: /search/i })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // The rail's own destination catalog — Photos, Collections, Review only
  // =========================================================================

  it('renders exactly three destination rows: Photos, Collections, Review', () => {
    render(<NavigationRail />);

    const links = screen.getAllByRole('link');
    const names = links.map((l) => l.getAttribute('aria-label') ?? l.textContent);
    expect(names).toEqual(['Photos', 'Collections', 'Review']);
  });
});
