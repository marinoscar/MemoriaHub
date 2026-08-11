/**
 * `/review` — the Review inbox (issue #390, spec §3.1 / §4.5).
 *
 * Thin by design: the list itself is `ReviewQueueList`, which #392 also mounts
 * as the desktop context pane. This page contributes the page chrome, scroll
 * restoration, the count invalidation below, and the desktop redirect.
 *
 * TWO SURFACES, ONE MODEL (spec §4.5), resolved exactly the way the Collections
 * hub resolves it:
 *
 *   phone   (< md)  →  the full hub list, drill into a queue, back
 *   tablet  (md–lg) →  the same list; the 56px rail has no room for a pane
 *   desktop (≥ lg)  →  NO list here. Redirect to the first enabled queue.
 *
 * THE DESKTOP REDIRECT is the part most likely to be "fixed" by a later reader,
 * so: spec §4.5's desktop row is "the same list rendered as the CONTEXT PANE,
 * side by side with the queue". #392 mounts `ReviewQueueList` as that pane — so
 * rendering the very same list again in `<main>` beside it is a menu next to a
 * menu, which is precisely what `CollectionsHubPage`'s `/collections` → `/albums`
 * redirect exists to avoid. Landing straight in the first queue puts real work
 * on screen in zero clicks, and the pane still gives the whole overview with
 * live counts. `/collections` established the pattern; this mirrors it.
 */

import { useEffect, useMemo } from 'react';
import { Box, Typography, useMediaQuery, useTheme } from '@mui/material';
import { Navigate } from 'react-router-dom';
import {
  ReviewQueueList,
  reviewQueuePath,
} from '../../components/review/ReviewQueueList';
import { refreshReviewCounts } from '../../hooks/useReviewCounts';
import { useReviewQueues } from '../../hooks/useReviewQueues';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';

export default function ReviewHubPage() {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));

  // Hooks run unconditionally, above the redirect branch. Restoration is a
  // no-op on desktop, where this page never paints a scrollable list.
  useScrollRestoration('review-hub', { enabled: !isDesktop });

  // The SAME resolver the pane and the rail badge read, so the queue this page
  // redirects into can never be one the pane does not list.
  //
  // This is a SECOND consumer of `useReviewCounts` on this page — the nested
  // `<ReviewQueueList>` below mounts its own. That is by design (the counts
  // hook deliberately does not dedupe; see its header), and the redundant
  // refetch it used to cause when `refreshReviewCounts()` fires below is now
  // absorbed by that hook's recency guard rather than by a cache here.
  const { entries, isLoading } = useReviewQueues();

  // Spec §4.5 requirement 1, and the criterion most likely to regress silently:
  // clearing four bursts and coming back to a cached "4" destroys the only
  // progress feedback the feature has. So the invalidation is explicit on every
  // mount rather than incidental to some hook's lifecycle — and because it goes
  // through the shared signal, the rail's aggregate badge moves with the list
  // instead of contradicting it. Kept on desktop too, where this component
  // mounts only briefly before redirecting: the pane is what renders the counts
  // there, and it observes the same signal.
  useEffect(() => {
    refreshReviewCounts();
  }, []);

  // First DRAINING queue in the registry's fixed order — never sorted by count
  // (spec §4.5 requirement 2), so the landing target is stable between visits
  // rather than moving with whatever happens to be full today.
  //
  // Falls back to the first `secondary` entry (Insights / Automations) when no
  // queue-producing feature is enabled at all: those still resolve, and a
  // deployment running only them should still land somewhere real.
  const landingEntry = useMemo(
    () =>
      entries.find((entry) => entry.group === 'queue') ??
      entries.find((entry) => entry.group === 'secondary') ??
      null,
    [entries],
  );

  // TWO conditions guard the redirect. What each one actually buys, stated
  // precisely — both were overstated in an earlier revision of this comment:
  //
  //  - `!isLoading` — waits for the FEATURE FLAGS. Redirecting off a
  //    half-resolved entry list would send the user into the wrong queue (or
  //    bounce them out of a legitimate one as a flag lands a beat later) with
  //    no way to tell why. It does NOT meaningfully wait for the COUNTS:
  //    `useReviewCounts` starts at `isLoading: false` and only flips inside an
  //    effect, which has not run when this first-render decision is made. That
  //    is harmless and needs no fixing — `landingEntry` is derived purely from
  //    the flags and the registry's fixed order, and never from a count — so a
  //    slow or failed counts request cannot change where we land. Do not add a
  //    counts gate here on the strength of the word "loading": it would delay
  //    the redirect for information the redirect does not use.
  //  - `landingEntry !== null` — a redirect to nowhere would be a blank
  //    screen. NOTE this branch is unreachable as the registry currently
  //    stands: `insights` carries `flag: null`, so it always resolves, and a
  //    deployment with every queue feature AND Automations disabled still lands
  //    on `/review/insights` — which is the right outcome, since Insights is
  //    genuinely the only thing left to show. The guard is kept for the same
  //    reason `ReviewQueueList` keeps its own all-disabled branch: it is the
  //    correct response if that ever changes, and the alternative is a blank
  //    screen rather than a loud failure.
  //
  // Falling through is deliberate in both cases rather than branching to a
  // bespoke state: the loading and all-disabled states already exist inside
  // `ReviewQueueList` and are the exact ones every other breakpoint shows.
  if (isDesktop && !isLoading && landingEntry !== null) {
    // `replace`, so Back from a queue returns to wherever the user actually
    // came from rather than bouncing through a route that immediately
    // redirects again — the same trap the Collections redirect avoids.
    return <Navigate to={reviewQueuePath(landingEntry.key)} replace />;
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Review
      </Typography>
      <ReviewQueueList variant="hub" />
    </Box>
  );
}
