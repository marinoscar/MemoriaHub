/**
 * The phone bottom bar — the ONLY navigation chrome below `sm`.
 *
 * Issue #392, epic #388, spec §4.1. Two things changed here and both are the
 * point of the phase:
 *
 * 1. **The "More" action is gone, and with it the drawer.** There is no
 *    hamburger in the top bar either. The 22-row drawer screen from the
 *    original bug report simply stops existing on a phone — Material 3
 *    acknowledges it has no recommended drawer replacement at this size, which
 *    is why the answer is a bottom bar and nothing else (spec §2.2).
 *
 * 2. **The five old rows (Photos / Explore / Map / Albums / More) become the
 *    four destinations.** Map and Albums moved into Collections, "Explore"
 *    was always routing to `/search` and is now named Search (spec §3.4).
 *    Four is the ceiling that keeps every label readable at 360px — five
 *    labels do not fit, which is why `showLabels` and a fifth item are
 *    mutually exclusive here.
 *
 * ACTIVE STATE COMES FROM THE DESTINATION MODEL, NOT A PATH PREFIX. Standing at
 * `/bursts` the selected tab is Review, and at `/albums/:id` it is Collections
 * — neither path resembles its destination, which is exactly why
 * `resolveActiveDestination` exists (spec §3.5). The old `startsWith` chain
 * this replaces could not express that, and would additionally have matched
 * `/reviewer` against Review.
 */

import {
  Badge,
  BottomNavigation,
  BottomNavigationAction,
  Paper,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Home as HomeIcon,
  Collections as CollectionsIcon,
  Search as SearchIcon,
  FactCheck as FactCheckIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { resolveActiveDestination } from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';
import { useReviewQueues } from '../../hooks/useReviewQueues';

export function BottomNav() {
  const theme = useTheme();
  // The EXACT complement of `Layout`'s `showRail` (`up('sm')`), and it must
  // stay that way: any drift opens a band with two navigation surfaces or none.
  // 600px is Material 3's compact/medium boundary — see the coupled-gate list
  // in `common/Layout.tsx` (issue #402).
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const location = useLocation();
  // The same aggregate the rail's badge reads, through the same hook — so the
  // two can never show different numbers across a breakpoint change.
  const { totalPending } = useReviewQueues();

  if (!isCompactWindow) return null;

  const resolved = resolveActiveDestination(location.pathname);
  // `false` (not `null`) is what MUI's BottomNavigation wants for "nothing
  // selected", which is the correct rendering on the routes spec §3.5 leaves
  // deliberately unowned (`/settings`, `/profile`, `/circles`, …) — and on
  // `/admin/*`, where the bar deliberately stays LIBRARY navigation with
  // nothing selected (spec §4.4 requirement 2: the admin surface is a place you
  // drilled into, always one tap from Photos, not a mode you are stuck in).
  const active: DestinationKey | false =
    resolved === null || resolved === 'console' ? false : resolved;

  const handleChange = (_: React.SyntheticEvent, value: DestinationKey) => {
    navigate(DESTINATION_PATHS[value]);
  };

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: theme.zIndex.appBar,
      }}
    >
      <BottomNavigation value={active} onChange={handleChange} showLabels>
        <BottomNavigationAction label="Photos" icon={<HomeIcon />} value="photos" />
        <BottomNavigationAction
          label="Collections"
          icon={<CollectionsIcon />}
          value="collections"
        />
        <BottomNavigationAction label="Search" icon={<SearchIcon />} value="search" />
        <BottomNavigationAction
          label="Review"
          value="review"
          // A DOT, not a number (spec §4.1): a 2-digit badge over a 4-up tab bar
          // at 360px collides with its neighbours' labels. The count is not
          // lost — it moves into the accessible name below, because a dot
          // carries no meaning whatsoever to a screen reader and a badge must
          // never be the sole carrier of it (spec §7).
          icon={
            totalPending > 0 ? (
              <Badge variant="dot" color="primary" overlap="circular">
                <FactCheckIcon />
              </Badge>
            ) : (
              <FactCheckIcon />
            )
          }
          aria-label={
            totalPending > 0 ? `Review, ${totalPending} items pending` : 'Review'
          }
        />
      </BottomNavigation>
    </Paper>
  );
}

/** Where each tab navigates. Kept beside the tabs so the two cannot drift. */
const DESTINATION_PATHS: Record<DestinationKey, string> = {
  photos: '/',
  collections: '/collections',
  search: '/search',
  review: '/review',
  // Console is not a tab (spec §4.4: the mode does not exist on a phone), but
  // the map is total over `DestinationKey` so a future tab cannot be added
  // without a path.
  console: '/admin/settings',
};
