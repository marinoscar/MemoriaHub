/**
 * `/review` — the Review inbox (issue #390, spec §3.1 / §4.5).
 *
 * Thin by design: the list itself is `ReviewQueueList`, which #392 also mounts
 * as the desktop context pane. This page contributes the page chrome, scroll
 * restoration, and the count invalidation below.
 */

import { useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import { ReviewQueueList } from '../../components/review/ReviewQueueList';
import { refreshReviewCounts } from '../../hooks/useReviewCounts';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';

export default function ReviewHubPage() {
  useScrollRestoration('review-hub');

  // Spec §4.5 requirement 1, and the criterion most likely to regress silently:
  // clearing four bursts and coming back to a cached "4" destroys the only
  // progress feedback the feature has. So the invalidation is explicit on every
  // mount rather than incidental to some hook's lifecycle — and because it goes
  // through the shared signal, the sidebar's aggregate badge moves with the
  // list instead of contradicting it.
  useEffect(() => {
    refreshReviewCounts();
  }, []);

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Review
      </Typography>
      <ReviewQueueList variant="hub" />
    </Box>
  );
}
