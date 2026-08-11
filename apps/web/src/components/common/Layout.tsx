import { Box, useMediaQuery, useTheme } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { AppBar } from '../navigation/AppBar';
import { NavigationRail } from '../navigation/NavigationRail';
import { NavContextPane } from '../navigation/NavContextPane';
import { BottomNav } from '../navigation/BottomNav';
import { MediaRefreshProvider } from '../../contexts/MediaRefreshContext';
import { MediaPreviewProvider } from '../../contexts/MediaPreviewContext';
import { SearchProvider } from '../../contexts/SearchContext';
import { MaintenanceBanner } from './MaintenanceBanner';

interface LayoutProps {
  /**
   * When true, `<main>` drops its padding and becomes a flex container so a
   * child (e.g. the Map page) can own the full available area edge-to-edge.
   */
  fullBleed?: boolean;
}

/**
 * The app shell — three navigation treatments, one per size class.
 *
 * Issue #392, epic #388, spec §4. The `Sidebar` drawer this used to mount is
 * gone from every breakpoint:
 *
 *   compact (< sm)  →  bottom bar only. No drawer, no hamburger, no drawer
 *                      state to manage — which is why this component no longer
 *                      holds any (spec §4.1).
 *   medium  (sm–lg) →  a permanent collapsed rail (~56px). Always visible, so
 *                      navigating costs zero taps instead of one (spec §4.2).
 *   expanded (≥ lg) →  expanded rail + a context pane for Collections and
 *                      Review (spec §4.3).
 *
 * The chrome is chosen by MOUNTING, not by rendering-then-hiding: exactly one
 * navigation surface exists in the tree at any width, so a resize across `sm`
 * or `lg` swaps it rather than briefly showing two.
 */
export function Layout({ fullBleed = false }: LayoutProps) {
  const theme = useTheme();
  // 600px, NOT 900px (issue #402). This is Material 3's MEDIUM window class
  // threshold — compact < 600dp, medium 600–840dp, expanded ≥ 840dp — and M3 is
  // explicit that a rail is the correct chrome from medium upward ("only use
  // navigation rails for medium window size classes and larger"), with "a
  // tablet or foldable in portrait" named as the canonical medium case. Gating
  // at MUI's `md` (900px) handed the phone treatment to every 600–899px device:
  // an unfolded Z Fold 7 (~750px), iPad portrait (768px), iPad Pro 11" portrait
  // (834px), Android tablets in portrait, and phones in landscape.
  //
  // ⚠️ FIVE GATES ARE COUPLED TO THIS ONE AND MUST MOVE TOGETHER. Moving the
  // rail alone renders two navigation surfaces, or none, in the gap:
  //   1. this `showRail`                               — the rail itself
  //   2. `BottomNav`'s `down('sm')`                    — the EXACT complement
  //   3. `AppBar`'s `isTabletUp` (`up('sm')`)          — search pill + upload label
  //   4. `AppBar`'s `isCompactWindow` (`down('sm')`)   — admin drill-down top bar
  //   5. `SettingsHubPage`'s `isCompactWindow`         — must agree with (4)
  // plus `<main>`'s `pb` below, which clears the bottom bar and so is only
  // needed where the bottom bar exists.
  //
  // The EXPANDED tier is deliberately left at `lg` (1200) rather than M3's
  // 840dp — see `showContextPane` below; that is a separate design decision.
  const showRail = useMediaQuery(theme.breakpoints.up('sm'));
  // The pane is a `lg`-and-up affordance, independent of the rail's collapse
  // preference: collapsing the rail reclaims RAIL width, it does not mean "I
  // want less context". A user on a 1400px screen who prefers a narrow rail
  // still has room for — and still benefits from — the second column.
  const showContextPane = useMediaQuery(theme.breakpoints.up('lg'));

  return (
    <MediaRefreshProvider>
      <MediaPreviewProvider>
      <SearchProvider>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            // The shell is the ONLY owner of viewport height — pages must not
            // nest their own 100vh inside it (issue #237), or the document is
            // always at least 100vh + AppBar + padding tall and scrolls even
            // when the content fits. `100dvh` tracks mobile browser chrome;
            // `100vh` measures against the LARGEST viewport, so a collapsing
            // URL bar adds jitter. The plain 100vh below is the fallback for
            // browsers without dvh support (same lesson as MediaMapPage).
            minHeight: '100vh',
            '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
            backgroundColor: theme.palette.background.default,
          }}
        >
          {/* Above the AppBar so it is visible on every authenticated screen
              (issue #348). Renders nothing for non-admins. */}
          <MaintenanceBanner />
          <AppBar />
          {/* `minWidth: 0` on the ROW as well as on each of its children: the
              row is itself a flex item of the column above, and issue #291's
              runaway width propagates through every level that omits it. */}
          <Box sx={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
            {/* Focus order follows visual order (spec §7): rail, then context
                pane, then main — which is also their DOM order here, so no
                tabindex juggling is needed to achieve it. */}
            {showRail && <NavigationRail />}
            {showContextPane && <NavContextPane />}
            <Box
              component="main"
              // `minWidth: 0` in BOTH branches is load-bearing, not cosmetic
              // (issue #291). A flex item's `min-width` defaults to `auto` —
              // its min-content width — so without this, any descendant that
              // reports a large intrinsic inline size (a `content-visibility`
              // placeholder, a wide table, a long unbroken string) cannot be
              // shrunk and widens the whole app shell past the viewport.
              sx={
                fullBleed
                  ? {
                      flexGrow: 1,
                      display: 'flex',
                      minWidth: 0,
                      minHeight: 0,
                      p: 0,
                    }
                  : {
                      flexGrow: 1,
                      minWidth: 0,
                      p: 3,
                      // Clears the fixed bottom bar, which only exists below
                      // `sm` — the same breakpoint `BottomNav` gates on. Moving
                      // this with the rail (issue #402) is what keeps 600–899px
                      // from carrying 80px of padding for a bar that is no
                      // longer mounted there.
                      pb: { xs: 10, sm: 3 },
                    }
              }
            >
              <Outlet />
            </Box>
          </Box>
          {/* Mounted only where it renders. `BottomNav` also gates itself on
              `down('sm')`, but it calls `useReviewQueues` for its badge, and
              `useReviewCounts` beneath that deliberately does NOT dedupe across
              consumers — so a self-gating-but-mounted bottom bar would double
              every counts request at `sm` and up, where the rail already holds
              one. `!showRail` is the exact complement of the rail's gate, so
              there is no width with two navs and none with zero. */}
          {!showRail && <BottomNav />}
        </Box>
      </SearchProvider>
      </MediaPreviewProvider>
    </MediaRefreshProvider>
  );
}
