/**
 * Cross-cutting breakpoint regression guard for issue #402.
 *
 * WHY THIS FILE EXISTS — AND WHY NOTHING ELSE CAUGHT THE BUG
 * ------------------------------------------------------------------
 * The navigation rail used to mount at MUI's `md` (900px). Material 3 puts a
 * rail at the "medium" window class starting at 600dp, so every width in
 * 600-899px — an unfolded Galaxy Z Fold 7 (~750px), iPad portrait (768px),
 * iPad Pro 11" portrait (834px), a phone in landscape — wrongly got the phone
 * (bottom-bar) treatment. The fix (`fix/rail-breakpoint-medium-600`) moved six
 * coupled gates from `md`/`900` to `sm`/`600`; see `Layout.tsx`'s file header
 * for the full coupled-gate list.
 *
 * Not one test in the pre-fix suite exercised the 600-899px band: every
 * viewport constant in `Layout.test.tsx`, `NavigationRail.test.tsx`,
 * `BottomNav.test.tsx`, and `SettingsHubPage.test.tsx` sat on the SAME side of
 * both 600 and 900 (either a phone width like 400, or a "tablet" width like
 * 950/1200 that is >= 900 too), so a wrong threshold and the right one produced
 * identical pass/fail outcomes. And the one in-band sample that DID exist
 * (`AppBar.test.tsx`'s 700px case) asserted only the wordmark, which was
 * already gated at `sm` before this fix and so could not have caught a
 * `md`-vs-`sm` mistake anywhere else.
 *
 * The lesson this file encodes: a breakpoint test that only samples the
 * breakpoint values the IMPLEMENTATION happens to use cannot detect a wrong
 * breakpoint value. Below, `setViewportWidth` computes `matches` from the
 * REAL min-width/max-width embedded in MUI's compiled query string rather than
 * a hard-coded boolean, so this file's assertions stand or fall on the actual
 * threshold in the component under test, not on an assumption baked into the
 * test itself.
 *
 * SCOPE OF THIS FILE vs. THE PER-COMPONENT SPECS
 * ------------------------------------------------------------------
 * This file owns the CROSS-CUTTING sweep: at every width in a range spanning
 * both breakpoints, exactly one primary nav is mounted (rail xor bottom bar),
 * which one, and whether the desktop context pane is present. It drives that
 * through the real `Layout` with a REAL, unmocked `BottomNav` — `NavigationRail`
 * and `NavContextPane` are mocked to bare presence-only stubs (their own
 * internal collapse/expand and content logic is exercised by
 * `NavigationRail.test.tsx`), and `AppBar` is mocked too, since none of its
 * three gates affect which primary nav mounts. Using a REAL `BottomNav` is
 * load-bearing: it self-gates on its OWN `down('sm')` query, so if `Layout`'s
 * `showRail` and `BottomNav`'s complement ever drift apart, this sweep is what
 * notices — a version of this file that mocked `BottomNav` too (as
 * `Layout.test.tsx`'s existing "exactly one nav" test does) would stay green
 * even if BOTH gates were wrong in the same direction, which is exactly how
 * issue #402 shipped undetected.
 *
 * The per-gate "coupling" checks for `AppBar` (search pill / admin drill-down)
 * and `SettingsHubPage` (card grid vs. drill-down list) live as dedicated
 * in-band (700px) cases inside their OWN spec files — `AppBar.test.tsx` and
 * `SettingsHubPage.test.tsx` — rather than duplicated here, since each already
 * owns the full mocking scaffold (SearchContext, MediaUploadDialog,
 * usePermissions, ...) its real component needs, and mounting a real `AppBar`
 * a second time inside a `Layout` tree here would either duplicate that
 * scaffold or force `AppBar` to stay mocked in this file (which it does, for
 * the sweep) — the two are not composable in one `vi.mock` graph. A regression
 * that moves any ONE of the six coupled gates back in isolation fails in the
 * file that owns that gate: `Layout`'s `showRail` and `BottomNav`'s
 * `down('sm')` fail HERE (jointly, via the XOR sweep — see above), `AppBar`'s
 * two gates fail in `AppBar.test.tsx`, and `SettingsHubPage`'s gate fails in
 * `SettingsHubPage.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils/test-utils';
import { Layout } from '../../components/common/Layout';
import type { UseReviewQueuesResult } from '../../hooks/useReviewQueues';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// `AppBar` is mocked: none of its three gates influence which PRIMARY nav
// mounts, so a real `AppBar` here would only add unrelated dependencies
// (search context, upload dialog, circle chip) to a file whose job is the
// rail/bottom-bar/context-pane sweep. `AppBar`'s own gates are covered in
// `AppBar.test.tsx` (see the file header above).
vi.mock('../../components/navigation/AppBar', () => ({
  AppBar: vi.fn(() => <div data-testid="mock-appbar">AppBar</div>),
}));
// `NavigationRail`'s presence is entirely `Layout`'s decision (the component
// itself has no mount-gate of its own — only an internal collapsed/expanded
// split at `lg`, unaffected by #402 and covered by `NavigationRail.test.tsx`).
// A presence-only stub is therefore sufficient here and keeps this file from
// needing `usePermissions`/`useNavigationPrefs`/etc.
vi.mock('../../components/navigation/NavigationRail', () => ({
  NavigationRail: vi.fn(() => <nav data-testid="mock-rail">Rail</nav>),
}));
// Same reasoning for the context pane: its own content (CollectionsList /
// ReviewQueueList) is irrelevant to "does it mount at >= lg".
vi.mock('../../components/navigation/NavContextPane', () => ({
  NavContextPane: vi.fn(() => <nav data-testid="mock-context-pane">Pane</nav>),
}));
// `BottomNav` is DELIBERATELY NOT mocked — see the file header. Its own
// `useReviewQueues()` call needs a mock so mounting it never issues a network
// request.
vi.mock('../../hooks/useReviewQueues', () => ({
  useReviewQueues: vi.fn(),
}));
// `Layout` renders `<Outlet />` with no `<Routes>` ancestor in this test's
// bare `MemoryRouter` wrapper, which throws without a route context — stubbed
// exactly as `Layout.test.tsx` already does, keeping every other
// `react-router-dom` export (used by the real `BottomNav`'s `useNavigate`/
// `useLocation`) untouched.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Outlet: vi.fn(() => <div data-testid="outlet-content">Page Content</div>),
  };
});

import { useReviewQueues } from '../../hooks/useReviewQueues';

const mockUseReviewQueues = vi.mocked(useReviewQueues);

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

// ---------------------------------------------------------------------------
// Viewport helper — evaluates the REAL min-width/max-width embedded in MUI's
// compiled breakpoint query string against `px`, rather than a hard-coded
// `matches` boolean. This is what lets a wrong threshold in the implementation
// actually fail a test here: a helper that hard-codes "matches: true for
// widths I consider desktop" would encode the same assumption the buggy `md`
// gate made and could not distinguish 600 from 900. Same technique as
// `Layout.test.tsx` / `AppBar.test.tsx` / `NavigationRail.test.tsx`.
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
  // setup.ts's suite-wide baseline: every query reports `matches: false`,
  // regardless of the query's own min-width/max-width. That is why every case
  // below calls `setViewportWidth` explicitly, even for a phone-sized width —
  // the raw baseline makes BOTH `up('sm')` and `down('sm')` false at once,
  // which is not a state any real viewport can be in and would silently hide
  // the very regression this file exists to catch (see `BottomNav.test.tsx`'s
  // file header for the same lesson applied to that component alone).
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

/** Render `Layout` at `px` and report which primary nav (if any) mounted. */
function renderChromeAt(px: number) {
  setViewportWidth(px);
  const { container } = render(<Layout />);
  return {
    railPresent: screen.queryByTestId('mock-rail') !== null,
    // `BottomNav` is real: it renders `<Paper>...</Paper>` when mounted, or
    // `null` (no DOM node at all) when its own `down('sm')` doesn't match —
    // so "present" is "the fixed bottom bar Paper exists in the DOM".
    bottomNavPresent: container.querySelector('.MuiBottomNavigation-root') !== null,
    panePresent: screen.queryByTestId('mock-context-pane') !== null,
  };
}

describe('breakpoint sweep — issue #402 (rail from Material 3\'s medium class, 600px)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreDefaultViewport();
    mockUseReviewQueues.mockReturnValue(reviewQueues());
  });

  afterEach(() => {
    restoreDefaultViewport();
  });

  // =========================================================================
  // 1. THE SWEEP — the assertion that would have caught #402.
  //
  // Widths deliberately include points BETWEEN the two breakpoints (768, 834),
  // both breakpoint values themselves (600, 900), and the pixel immediately
  // below each (599, 899) — not only widths the implementation happens to use.
  // 768 (iPad portrait) is the single most important row: spec §4.2 and epic
  // #388's criterion 6 both name it, and it is the width at which the rail
  // never rendered pre-fix.
  // =========================================================================

  describe('exactly one primary nav at every width; the correct one; context pane only >= 1200', () => {
    it.each([
      [360, 'bottom', false],
      [599, 'bottom', false],
      [600, 'rail', false],
      [768, 'rail', false],
      [834, 'rail', false],
      [899, 'rail', false],
      [900, 'rail', false],
      [1200, 'rail', true],
    ] as const)('%dpx → %s bar, context pane present: %s', (px, expectedNav, expectedPane) => {
      const { railPresent, bottomNavPresent, panePresent } = renderChromeAt(px);

      // XOR: exactly one of rail / bottom bar, never both, never neither.
      expect(railPresent).toBe(!bottomNavPresent);
      expect(railPresent || bottomNavPresent).toBe(true);

      // Which one.
      if (expectedNav === 'rail') {
        expect(railPresent).toBe(true);
        expect(bottomNavPresent).toBe(false);
      } else {
        expect(railPresent).toBe(false);
        expect(bottomNavPresent).toBe(true);
      }

      // The context pane, independently.
      expect(panePresent).toBe(expectedPane);
    });
  });

  // =========================================================================
  // 2. Device-shaped cases, named so their intent survives a future refactor.
  // =========================================================================

  describe('device-shaped widths', () => {
    it('unfolded Galaxy Z Fold 7 (~750px) gets the rail, not the bottom bar', () => {
      const { railPresent, bottomNavPresent } = renderChromeAt(750);
      expect(railPresent).toBe(true);
      expect(bottomNavPresent).toBe(false);
    });

    it('a folded / compact phone width (~400px) gets the bottom bar, not the rail', () => {
      const { railPresent, bottomNavPresent } = renderChromeAt(400);
      expect(railPresent).toBe(false);
      expect(bottomNavPresent).toBe(true);
    });

    it('iPad portrait (768px) gets the rail, not the bottom bar', () => {
      const { railPresent, bottomNavPresent } = renderChromeAt(768);
      expect(railPresent).toBe(true);
      expect(bottomNavPresent).toBe(false);
    });

    it('iPad Pro 11" portrait (834px) gets the rail, not the bottom bar', () => {
      const { railPresent, bottomNavPresent } = renderChromeAt(834);
      expect(railPresent).toBe(true);
      expect(bottomNavPresent).toBe(false);
    });

    it('a phone in landscape (~740px, e.g. a 360x740 phone rotated) gets the rail', () => {
      // Width-driven chrome selection does not distinguish "phone" from
      // "tablet" by device category — only by the reported viewport width —
      // so a phone rotated into landscape is exactly the medium-window case
      // spec §4.2 names.
      const { railPresent, bottomNavPresent } = renderChromeAt(740);
      expect(railPresent).toBe(true);
      expect(bottomNavPresent).toBe(false);
    });
  });
});
