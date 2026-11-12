/**
 * The desktop context panes — the second column, beside the rail.
 *
 * RETRO-F1 (#571): the column itself (its 240px width, sticky geometry, border
 * and `<aside>` landmark) is now the packaged shell's: `ShellNavigationRail`
 * draws the active destination's `ShellDestination.contextPane` beside the
 * EXPANDED rail (its own `lg` and not-collapsed state, not a new breakpoint
 * gate). This file supplies the two panes' CONTENTS, bound in
 * `config/shell.ts` to the Collections and Review destinations. One behaviour
 * moved with it: collapsing the desktop rail now also hides the pane (the
 * shell ties the pane to the expanded rail), where the app used to keep it at
 * `lg` regardless of the collapse preference.
 *
 * Issue #392, epic #388, spec §4.3. It shows what is INSIDE the selected
 * destination, so depth costs a glance rather than a tap. That is what recovers
 * the extra tap §6.1 concedes for Collections: on desktop there is no
 * drill-down at all.
 *
 * IT RENDERS FOR EXACTLY TWO DESTINATIONS
 * ---------------------------------------
 * Collections and Review, and nothing else. Photos and Search are
 * single-surface destinations that render at full width — an empty 240px column
 * beside them would be strictly worse than no column, and a pane that appears
 * and disappears with a stable set of destinations is a spatial-memory failure.
 * Console has its own rail contents instead (see `NavigationRail`), so it gets
 * no pane either.
 *
 * IT MOUNTS THE HUBS' OWN COMPONENTS — it does not reimplement them
 * ----------------------------------------------------------------
 * `ReviewQueueList` and `CollectionsList` were both built as standalone
 * components in #390/#391 specifically so this pane could mount them
 * (`variant="pane"`). A second implementation here would let row order, feature
 * gating and count refresh drift between two surfaces that are supposed to be
 * the same list at two sizes — which is the whole reason the registries are
 * data rather than JSX baked into a page.
 *
 * SELECTING A ROW ON DESKTOP — which interpretation is implemented
 * ---------------------------------------------------------------
 * "Render that queue in the main area without navigating away from /review" is
 * implemented as: the row navigates to `/review/<key>`, which `App.tsx` already
 * routes to `ReviewQueuePage` INSIDE this same shell — so the rail and this
 * pane stay mounted across the click, the pane marks the row active via
 * `activeKey`, and only the `<main>` column changes. There is no drill-down, no
 * full-page transition, and no separate "pane-only" navigation mode. The URL
 * moves (it must — the queue has to be linkable and reloadable), but the
 * CHROME does not, which is what the requirement is actually about. Collections
 * works identically: its rows point at `/albums`, `/people`, … and the pane
 * survives the navigation.
 */

import { Box, Typography, useTheme } from '@mui/material';
import type { ShellContextPaneProps } from '@marinoscar/platform-web/shell/headless';
import { COLLECTIONS, CollectionsList, REVIEW_QUEUES, ReviewQueueList } from '@marinoscar/memoriahub-web/hubs/ui';
import type { CollectionKey, ReviewQueueKey } from '@marinoscar/memoriahub-web/hubs/ui';
import { owns } from '../../config/destinations';

/**
 * Which review entry the current URL is showing, or `null`.
 *
 * Two shapes must both resolve, because both are live routes: the hub's own
 * `/review/:queue`, and every queue's ORIGINAL standalone path (`/bursts`,
 * `/location-suggestions`, …), which #390 deliberately kept working because
 * bookmarks, the Home review banners and the `review_queue_*` notification
 * links all point at them.
 */
function resolveReviewKey(pathname: string): ReviewQueueKey | null {
  for (const entry of REVIEW_QUEUES) {
    if (owns(`/review/${entry.key}`, pathname)) return entry.key;
    if (owns(entry.path, pathname)) return entry.key;
  }
  return null;
}

/**
 * Which collection the current URL is showing, or `null`.
 *
 * FAVORITES IS DELIBERATELY NOT MATCHED HERE, and an earlier revision's
 * query-string special case for it has been deleted as dead code. Its target,
 * `/media?favorite=1`, is owned by the `photos` destination (spec §3.5's
 * table), so `resolveActiveDestination` returns `photos` and this pane has
 * already returned `null` before this function is ever reached on that route.
 * A `favorite=1` branch here could never run, and leaving it in place would
 * read as load-bearing support for a case the component does not actually
 * handle. The gap itself is documented at the Favorites entry in
 * `config/collections.tsx`, together with why fixing it is out of scope.
 *
 * The `includes('?')` skip below is what keeps that entry from being matched by
 * accident — its `path` is not a bare prefix and `owns()` would never be right
 * for it.
 */
function resolveCollectionKey(pathname: string): CollectionKey | null {
  for (const entry of COLLECTIONS) {
    if (entry.path.includes('?')) continue;
    if (owns(entry.path, pathname)) return entry.key;
  }
  return null;
}

function PaneHeading({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Typography
      component="h2"
      variant="overline"
      sx={{
        px: 1,
        display: 'block',
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: theme.palette.text.disabled,
      }}
    >
      {children}
    </Typography>
  );
}

/** Review's pane: the hub's own `ReviewQueueList`, never a second implementation. */
export function ReviewContextPane({ pathname }: ShellContextPaneProps) {
  return (
    // `minWidth: 0` (issue #291): a long label must not set a min-content floor.
    <Box sx={{ px: 1, py: 1.5, minWidth: 0 }}>
      <PaneHeading>Review</PaneHeading>
      <ReviewQueueList variant="pane" activeKey={resolveReviewKey(pathname)} />
    </Box>
  );
}

/** Collections' pane: the hub's own `CollectionsList`. */
export function CollectionsContextPane({ pathname }: ShellContextPaneProps) {
  return (
    <Box sx={{ px: 1, py: 1.5, minWidth: 0 }}>
      <PaneHeading>Collections</PaneHeading>
      <CollectionsList variant="pane" activeKey={resolveCollectionKey(pathname)} />
    </Box>
  );
}
