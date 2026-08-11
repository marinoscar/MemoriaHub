/**
 * Tests for `Layout` (issue #392, epic #388, spec §4).
 *
 * The drawer this used to mount (`Sidebar`, with its open/close state) is
 * gone from every breakpoint — replaced by three navigation TREATMENTS
 * selected by MOUNTING, not by rendering-then-hiding: `NavigationRail`,
 * `NavContextPane`, and `BottomNav`. Each is mocked as a simple stub so this
 * file tests exactly what belongs to `Layout` itself — WHICH chrome mounts at
 * which breakpoint, and that exactly one navigation surface exists in the
 * tree at any width (never a rail and a bottom bar together, never neither).
 *
 * `AppBar` takes no props as of #392 (the `onMenuClick` hamburger callback
 * went away with the drawer it opened), so the mock here is a bare stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockUser } from '../../utils/test-utils';
import { Layout } from '../../../components/common/Layout';

// ---------------------------------------------------------------------------
// Module mocks — each nav surface is a simple, breakpoint-agnostic stub, so
// this file's viewport control drives ONLY `Layout`'s own `up('sm')`/`up('lg')`
// gates (issue #402 moved the rail's gate from `up('md')` to `up('sm')`),
// never a self-gate belonging to the real components (`BottomNav`
// self-gates on `down('sm')` too; that overlap is exercised for real, with a
// REAL BottomNav, in `navigation/breakpoints.test.tsx` — mocking both here
// means this file's own "exactly one nav" check below cannot detect the two
// gates drifting apart, only that whatever `Layout` decides is internally
// consistent with itself).
// ---------------------------------------------------------------------------

vi.mock('../../../components/navigation/AppBar', () => ({
  AppBar: vi.fn(() => <div data-testid="mock-appbar">AppBar</div>),
}));
vi.mock('../../../components/navigation/NavigationRail', () => ({
  NavigationRail: vi.fn(() => <nav data-testid="mock-rail">Rail</nav>),
}));
vi.mock('../../../components/navigation/NavContextPane', () => ({
  NavContextPane: vi.fn(() => <nav data-testid="mock-context-pane">Pane</nav>),
}));
vi.mock('../../../components/navigation/BottomNav', () => ({
  BottomNav: vi.fn(() => <div data-testid="mock-bottomnav">BottomNav</div>),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Outlet: vi.fn(() => <div data-testid="outlet-content">Page Content</div>),
  };
});

import { AppBar } from '../../../components/navigation/AppBar';
import { Outlet } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Viewport helper — same technique as AppBar.test.tsx / CollectionsHubPage.test.tsx.
// The suite baseline (setup.ts) reports every query `matches: false`, which
// for `up('sm')` reads as "below sm" — the phone treatment — so phone needs
// no explicit call; medium and desktop do. (Issue #402: the rail's mount gate
// pivoted from `up('md')`/900px to `up('sm')`/600px — see `Layout.tsx`'s file
// header for the full coupled-gate list this component is one of six in.)
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

// Renamed from the pre-#402 `TABLET_WIDTH = 950` (>= md/900) to a genuinely
// in-band width: 768 is iPad portrait, spec §4.2's and epic #388 criterion
// 6's named case, and the width at which the rail never rendered pre-fix.
// 950 would still pass today (it is also >= sm/600) but no longer documents
// anything meaningful about the "medium" window class this component targets.
const MEDIUM_WIDTH = 768; // >= sm(600), < lg(1200) — Material 3's medium band
const DESKTOP_WIDTH = 1300; // >= lg(1200)

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreDefaultViewport();
  });

  afterEach(() => {
    restoreDefaultViewport();
  });

  // =========================================================================
  // Basic structure
  // =========================================================================

  describe('Rendering', () => {
    it('renders AppBar', () => {
      render(<Layout />);
      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
    });

    it('renders Outlet content inside a <main> element', () => {
      render(<Layout />);

      const outletContent = screen.getByTestId('outlet-content');
      const mainElement = outletContent.closest('main');
      expect(mainElement).toBeInTheDocument();
      expect(vi.mocked(Outlet)).toHaveBeenCalled();
    });

    it('calls AppBar with no props (the hamburger callback is gone with the drawer)', () => {
      render(<Layout />);

      expect(vi.mocked(AppBar)).toHaveBeenCalledWith({}, undefined);
    });
  });

  // =========================================================================
  // Chrome per breakpoint — the epic's success criterion #2: no breakpoint
  // falls back to "whatever the drawer did". Each treatment is asserted by
  // WHICH stub is present, not by a hidden/visible style — the chrome is
  // chosen by mounting.
  // =========================================================================

  describe('chrome per breakpoint', () => {
    it('phone (< md): BottomNav only — no rail, no context pane', () => {
      render(<Layout />);

      expect(screen.getByTestId('mock-bottomnav')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-rail')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-context-pane')).not.toBeInTheDocument();
    });

    it('medium (sm-lg): rail only — no context pane, no bottom bar', () => {
      setViewportWidth(MEDIUM_WIDTH);
      render(<Layout />);

      expect(screen.getByTestId('mock-rail')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-context-pane')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-bottomnav')).not.toBeInTheDocument();
    });

    it('desktop (>= lg): rail AND context pane — no bottom bar', () => {
      setViewportWidth(DESKTOP_WIDTH);
      render(<Layout />);

      expect(screen.getByTestId('mock-rail')).toBeInTheDocument();
      expect(screen.getByTestId('mock-context-pane')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-bottomnav')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Exactly one PRIMARY nav (rail xor bottom bar) at every breakpoint —
  // never both together, never neither. `Layout` mounts the rail under
  // `up('sm')` (issue #402) and the MOCKED `BottomNav` stub under `!showRail`,
  // the exact complement — but note both surfaces are stubs here, so this
  // proves only that `Layout` itself is internally consistent, not that its
  // gate agrees with the REAL `BottomNav`'s own `down('sm')` self-gate. That
  // cross-component agreement — the actual issue #402 regression — is what
  // `navigation/breakpoints.test.tsx` checks with a real, unmocked `BottomNav`.
  // =========================================================================

  describe('exactly one primary nav at each breakpoint', () => {
    it.each([
      ['phone', undefined],
      ['medium', MEDIUM_WIDTH],
      ['desktop', DESKTOP_WIDTH],
    ] as const)('%s: rail and bottom bar are mutually exclusive', (_label, width) => {
      if (width) setViewportWidth(width);

      render(<Layout />);

      const railPresent = screen.queryByTestId('mock-rail') !== null;
      const bottomNavPresent = screen.queryByTestId('mock-bottomnav') !== null;

      // XOR: exactly one of the two is present.
      expect(railPresent).toBe(!bottomNavPresent);
      expect(railPresent || bottomNavPresent).toBe(true);
    });
  });

  // =========================================================================
  // Focus order — rail, then context pane, then main (spec §7), enforced by
  // DOM order since no tabindex juggling is used to achieve it.
  // =========================================================================

  it('at desktop, the rail precedes the context pane precedes <main> in DOM order', () => {
    setViewportWidth(DESKTOP_WIDTH);
    const { container } = render(<Layout />);

    const rail = screen.getByTestId('mock-rail');
    const pane = screen.getByTestId('mock-context-pane');
    const main = screen.getByTestId('outlet-content').closest('main') as HTMLElement;

    const position = (a: Node, b: Node) =>
      // eslint-disable-next-line no-bitwise
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

    expect(container.contains(rail)).toBe(true);
    expect(position(rail, pane)).toBeTruthy();
    expect(position(pane, main)).toBeTruthy();
  });

  // =========================================================================
  // Issue #291 — <main> must be able to shrink below its content
  //
  // <main> is a flex item, and a flex item's `min-width` defaults to `auto`
  // (its min-content width). Without an explicit `min-width: 0`, any
  // descendant reporting a large intrinsic inline size — a `content-visibility`
  // placeholder, a wide table, a long unbroken string — cannot be shrunk and
  // widens the entire app shell past the viewport. This is the
  // defence-in-depth half of the mobile gallery blow-up fix, and it must keep
  // passing unchanged across this rewrite.
  // =========================================================================

  describe('Main flex item shrinkability (issue #291)', () => {
    it('applies min-width: 0 to <main> in the default branch', () => {
      render(<Layout />);

      const mainElement = screen.getByTestId('outlet-content').closest('main');

      expect(mainElement).toBeInTheDocument();
      expect(getComputedStyle(mainElement as HTMLElement).minWidth).toBe('0px');
    });

    it('applies min-width: 0 to <main> in the fullBleed branch', () => {
      render(<Layout fullBleed />);

      const mainElement = screen.getByTestId('outlet-content').closest('main');

      expect(mainElement).toBeInTheDocument();
      expect(getComputedStyle(mainElement as HTMLElement).minWidth).toBe('0px');
    });
  });

  // =========================================================================
  // Theme / auth integration — unaffected by the drawer removal, kept as a
  // smoke test that the shell still composes with the app's other providers.
  // =========================================================================

  describe('Integration with theme and auth context', () => {
    it('renders with light theme', () => {
      render(<Layout />, { wrapperOptions: { theme: 'light' } });
      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
    });

    it('renders with dark theme', () => {
      render(<Layout />, { wrapperOptions: { theme: 'dark' } });
      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
    });

    it('renders with an authenticated user', () => {
      render(<Layout />, { wrapperOptions: { authenticated: true, user: mockUser } });
      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it('renders when not authenticated', () => {
      render(<Layout />, { wrapperOptions: { authenticated: false, user: null } });
      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
    });
  });
});
