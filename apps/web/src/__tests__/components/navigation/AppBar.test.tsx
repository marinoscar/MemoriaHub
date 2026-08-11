import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { AppBar } from '../../../components/navigation/AppBar';
import { APP_NAME } from '../../../constants/app';
import type { Circle } from '../../../types/circles';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// TopbarSearch calls useSearch() which requires SearchProvider.
// Mock the entire SearchContext module so TopbarSearch can render in isolation.
vi.mock('../../../contexts/SearchContext', () => ({
  useSearch: vi.fn(() => ({
    messages: [],
    results: null,
    isSearching: false,
    error: null,
    searchRequest: null,
    runAgentSearch: vi.fn(),
    runDeterministicSearch: vi.fn(),
    clearSearch: vi.fn(),
  })),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// SearchPanel is heavy — stub it out for AppBar tests
vi.mock('../../../components/search/SearchPanel', () => ({
  SearchPanel: vi.fn(() => null),
}));

// MediaUploadDialog — stub to avoid upload service calls
vi.mock('../../../components/media/MediaUploadDialog', () => ({
  MediaUploadDialog: vi.fn(({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="upload-dialog"><button onClick={onClose}>Close</button></div> : null,
  ),
}));

// useCircle is mocked directly (rather than relying on test-utils' single-
// circle CircleContext wrapper) so the CircleChip tests below can exercise a
// real multi-circle menu and assert on `setActiveCircle` calls — the same
// pattern UserMenu.test.tsx already uses for the circle switcher it used to
// own before spec §3.3 moved it here.
vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

import { useCircle } from '../../../hooks/useCircle';

const mockUseCircle = vi.mocked(useCircle);

const mockCircle1: Circle = {
  id: 'circle-1',
  name: "Test User's Library",
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockCircle2: Circle = {
  id: 'circle-2',
  name: 'Family Circle',
  description: 'Our family',
  ownerId: 'test-user-id',
  isPersonal: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeCircleDefaults(overrides: Record<string, unknown> = {}) {
  return {
    circles: [mockCircle1],
    activeCircle: mockCircle1,
    activeCircleId: mockCircle1.id,
    activeCircleRole: 'circle_admin' as const,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Viewport helper — computes `matches` from the actual min-width/max-width
// embedded in MUI's compiled breakpoint query string, so a single `px` value
// drives every `useMediaQuery(...)` call in the component consistently
// (AppBar reads three different breakpoints: up('md'), down('sm'),
// down('md')). Mirrors the technique in NotificationPanel.test.tsx, made
// width-based instead of a fixed query-string check.
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
  // Matches setup.ts's baseline: every query reports `matches: false`.
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

// ---------------------------------------------------------------------------

describe('AppBar', () => {
  beforeEach(() => {
    mockUseCircle.mockReturnValue(makeCircleDefaults());
  });

  afterEach(() => {
    restoreDefaultViewport();
  });

  describe('Rendering', () => {
    it('should render app title', () => {
      // The wordmark is desktop-only (>= md, 900px — see the "Brand slot"
      // section below for the full threshold); an explicit desktop width
      // keeps this generic "does the title render" case width-independent in
      // intent rather than relying on the raw jsdom default, which reports
      // every media query as non-matching and so is not equivalent to any
      // real viewport for an `up(...)` gate.
      setViewportWidth(1200);

      render(<AppBar />);

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    });

    it('should render as banner landmark', () => {
      render(<AppBar />);

      const appBar = screen.getByRole('banner');
      expect(appBar).toBeInTheDocument();
    });
  });

  describe('Theme Toggle', () => {
    it('should render theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
    });

    it('should show dark mode icon in light mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'light' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Dark mode icon (moon) should be shown when in light mode
    });

    it('should show light mode icon in dark mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'dark' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Light mode icon (sun) should be shown when in dark mode
    });

    it('should toggle theme on click', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      await user.click(toggleButton);

      // Theme should have toggled (via ThemeContext)
      expect(toggleButton).toBeInTheDocument();
    });
  });

  describe('User Menu', () => {
    it('should render user menu', () => {
      render(<AppBar />);

      // UserMenu component should be rendered (contains avatar button)
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should show user menu for authenticated users', () => {
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      // Should have at least theme toggle and user menu button
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Navigation', () => {
    it('should navigate to home when title is clicked', async () => {
      const user = userEvent.setup();
      setViewportWidth(1200); // desktop — the wordmark needs >= md to render

      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      await user.click(title);

      // Navigation should be triggered
      expect(title).toBeInTheDocument();
    });

    it('should have clickable title', () => {
      setViewportWidth(1200); // desktop — the wordmark needs >= md to render

      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      expect(title).toHaveStyle({ cursor: 'pointer' });
    });
  });

  describe('Styling', () => {
    it('should use sticky positioning', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
      // AppBar should have sticky position applied via MUI
    });

    it('should have proper elevation', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should render all elements on desktop', () => {
      setViewportWidth(1200); // the wordmark needs >= md to render

      render(<AppBar />);

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toHaveAccessibleName();
    });

    it('should have proper ARIA landmarks', () => {
      render(<AppBar />);

      expect(screen.getByRole('banner')).toBeInTheDocument();
    });
  });

  describe('Brand slot', () => {
    it('renders logo image on desktop viewport', () => {
      setViewportWidth(1200); // >= md(900) → isDesktopBrand=true → desktop scenario

      render(<AppBar />);

      // Desktop: both the logo img and the wordmark text are rendered.
      expect(screen.getByRole('img', { name: APP_NAME })).toBeInTheDocument();
      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    });

    it('logo and wordmark both navigate to home on click', async () => {
      const user = userEvent.setup();
      render(<AppBar />);
      // The brand wrapper Box has the onClick; clicking the img triggers navigation.
      // The logo itself renders at every width (only the wordmark's threshold
      // differs), so this needs no explicit viewport.
      const logoImg = screen.getByRole('img', { name: APP_NAME });
      await user.click(logoImg);
      expect(logoImg).toBeInTheDocument();
    });

    it('hides the wordmark below the md breakpoint (phone and medium/tablet)', () => {
      setViewportWidth(360); // < 900 → isDesktopBrand=false

      render(<AppBar />);

      expect(screen.getByRole('img', { name: APP_NAME })).toBeInTheDocument();
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();
    });

    // -----------------------------------------------------------------------
    // The wordmark's own threshold — a SECOND, differently-placed boundary
    // ---------------------------------------------------------------------
    // Unlike the rest of this row's compact behaviour (`isTabletUp`/
    // `isCompactWindow`, both gated at `sm`/600px per issue #402), the
    // wordmark stays hidden through the whole medium band and only appears at
    // `md`/900px. Once the rail moved to 600, the medium band (600-899px)
    // newly carries the wordmark AND the circle chip AND the search pill at
    // once, and that row is tight at ~600px — the chip would truncate toward
    // icon-plus-caret and the pill's placeholder would clip. The wordmark is
    // the one purely decorative element of the three (the logo beside it
    // already carries brand identity), so it is the one sacrificed; shrinking
    // `CircleChip` instead would have degraded a functional control to
    // preserve a decorative one. This mirrors the exact trade the phone
    // treatment already makes ("which circle you are in matters more than the
    // app's name") — it just applies through 900px now, not only below 600.
    //
    // Sampled on BOTH sides of BOTH boundaries (600 and 900) — a test that
    // only checked 360 and 1200 could not distinguish this threshold from the
    // old, single `sm` one, which is exactly the class of mistake issue #402
    // itself was.
    it.each([
      [360, false], // phone
      [599, false], // just below the rail threshold
      [600, false], // the rail/search/chip threshold — wordmark stays hidden here
      [700, false], // in-band: rail + search pill + chip are already tablet-up
      [899, false], // just below the wordmark's own threshold
      [900, true], // the wordmark's own threshold
      [1200, true], // desktop
    ])('wordmark visible at %dpx: %s (logo always renders)', (px, wordmarkVisible) => {
      setViewportWidth(px);

      render(<AppBar />);

      expect(screen.getByRole('img', { name: APP_NAME })).toBeInTheDocument();
      if (wordmarkVisible) {
        expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      } else {
        expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();
      }
    });
  });

  describe('Upload button', () => {
    it('shows Upload button when an active circle is present', () => {
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      // The test-utils wrapper provides a default active circle.
      // AppBar shows Upload button (either outlined button or icon button) when circle is set.
      const uploadBtns = screen.queryAllByRole('button', { name: /upload media/i });
      expect(uploadBtns.length).toBeGreaterThanOrEqual(1);
    });

    it('opens MediaUploadDialog when Upload is clicked', async () => {
      const user = userEvent.setup();
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      const uploadBtn = screen.getByRole('button', { name: /upload media/i });
      await user.click(uploadBtn);

      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Circle chip (spec §3.3) — promoted into the top bar
  // =========================================================================

  describe('Circle chip', () => {
    it('renders the active circle name', () => {
      render(<AppBar />);

      expect(screen.getByText("Test User's Library")).toBeInTheDocument();
    });

    it('opens the circle menu on click', async () => {
      const user = userEvent.setup();
      mockUseCircle.mockReturnValue(makeCircleDefaults({ circles: [mockCircle1, mockCircle2] }));

      render(<AppBar />);

      await user.click(screen.getByRole('button', { name: /active circle/i }));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      expect(screen.getByRole('menuitem', { name: /family circle/i })).toBeInTheDocument();
    });

    it('calls setActiveCircle when a different circle is picked', async () => {
      const setActiveCircle = vi.fn().mockResolvedValue(undefined);
      mockUseCircle.mockReturnValue(
        makeCircleDefaults({ circles: [mockCircle1, mockCircle2], setActiveCircle }),
      );

      const user = userEvent.setup();
      render(<AppBar />);

      await user.click(screen.getByRole('button', { name: /active circle/i }));
      const familyItem = await screen.findByRole('menuitem', { name: /family circle/i });
      await user.click(familyItem);

      await waitFor(() => {
        expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
      });
    });

    it('navigates to /circles when "Manage Circles" is clicked', async () => {
      const user = userEvent.setup();
      render(<AppBar />);

      await user.click(screen.getByRole('button', { name: /active circle/i }));
      const manageItem = await screen.findByRole('menuitem', { name: /manage circles/i });
      await user.click(manageItem);

      // The chip's menu closes and the app navigates — asserted via the menu
      // disappearing, since AppBar itself does not mock useNavigate here.
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('renders nothing when there is no active circle', () => {
      mockUseCircle.mockReturnValue(makeCircleDefaults({ activeCircle: null, activeCircleId: null }));

      render(<AppBar />);

      expect(screen.queryByRole('button', { name: /active circle/i })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Admin drill-down header (spec §4.4) — down('sm') + an /admin/* route
  // (issue #402: this gate pivoted from down('md')/900px to down('sm')/600px,
  // coupled to `Layout`'s `showRail` — see that file's header for the full
  // coupled-gate list)
  // =========================================================================

  describe('Admin drill-down (phone only, since #402)', () => {
    it('renders Back + the resolved page title, and hides the circle chip, upload button, and search', () => {
      setViewportWidth(500); // < 600 → down('sm') matches → isCompactWindow=true

      render(<AppBar />, {
        wrapperOptions: { route: '/admin/settings/jobs', authenticated: true },
      });

      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Job Queue' })).toBeInTheDocument();

      expect(screen.queryByRole('button', { name: /active circle/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /upload media/i })).not.toBeInTheDocument();
      // TopbarSearch is entirely absent — no hamburger either, since it too
      // is dropped from this header per spec §4.4.
      expect(screen.queryByRole('button', { name: 'toggle drawer' })).not.toBeInTheDocument();
    });

    it('back from a detail page (e.g. Job Queue) navigates to the hub, /admin/settings', async () => {
      const user = userEvent.setup();
      setViewportWidth(500);

      render(<AppBar />, {
        wrapperOptions: { route: '/admin/settings/jobs', authenticated: true },
      });

      await user.click(screen.getByRole('button', { name: 'Back' }));

      // No mocked useNavigate here; assert via the route-dependent title,
      // which flips to the hub's title once the MemoryRouter has actually
      // navigated to /admin/settings.
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
      });
    });

    it('back from the hub itself (/admin/settings) navigates to /', async () => {
      const user = userEvent.setup();
      setViewportWidth(500);

      render(<AppBar />, {
        wrapperOptions: { route: '/admin/settings', authenticated: true },
      });

      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      // Having left /admin entirely, the drill-down header itself
      // unmounts — the normal toolbar (with the circle chip) takes over.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /active circle/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('renders the normal toolbar (circle chip present) at the same narrow width on a non-admin route', () => {
      setViewportWidth(500);

      render(<AppBar />, {
        wrapperOptions: { route: '/', authenticated: true },
      });

      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /active circle/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Coupling regression guard (issue #402) — at an IN-BAND width (600-899px,
  // e.g. 700), both of AppBar's gates must have already flipped to their
  // tablet-up treatment: the search pill shows (isTabletUp), and even on an
  // admin route the drill-down header must NOT appear (isCompactWindow).
  // Before this fix both were gated at `md`/900px, so 700px still got the
  // phone treatment on both counts. A regression that moves either gate back
  // to `md` in isolation fails one of the two assertions below, independent
  // of whatever `Layout`/`BottomNav` do — see `navigation/breakpoints.test.tsx`
  // for the companion cross-cutting sweep this pairs with.
  // =========================================================================

  describe('in-band width (700px) — issue #402 coupling', () => {
    it('renders the search pill and does NOT render the admin drill-down header, even on an /admin/* route', () => {
      setViewportWidth(700); // >= 600 → isTabletUp=true, isCompactWindow=false

      render(<AppBar />, {
        wrapperOptions: { route: '/admin/settings/jobs', authenticated: true },
      });

      // isTabletUp: the inline search pill (not the phone icon-only button).
      expect(screen.getByPlaceholderText('Search your photos')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open search' })).not.toBeInTheDocument();

      // isCompactWindow: no drill-down header, even though the route is
      // /admin/* — the normal toolbar (with the circle chip) renders instead.
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Job Queue' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /active circle/i })).toBeInTheDocument();

      // A THIRD, independent gate lives in this same in-band row: the
      // wordmark (`isDesktopBrand`, `up('md')`/900px) stays hidden through the
      // whole medium band so the chip and the search pill have the width —
      // see the "Brand slot" section's dedicated sweep for the full rationale
      // and boundary coverage. The logo alone still carries brand identity.
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();
      expect(screen.getByRole('img', { name: APP_NAME })).toBeInTheDocument();
    });
  });
});
