/**
 * `/review/:queue` — one queue inside the Review hub (issue #390).
 *
 * A WRAPPER, not a rewrite. Each queue's page is mounted verbatim; none of them
 * is modified, and none of their standalone routes (`/bursts`, `/duplicates`, …)
 * is removed or redirected. Bookmarks, the Home review banners and the
 * `review_queue_*` notification links all point at those routes, and the epic's
 * central claim is that nothing becomes unreachable.
 *
 * What this page adds around the wrapped content is the hub's two affordances:
 * a way back, and chain-to-next.
 */

import { Suspense, lazy } from 'react';
import { Box, Button, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Link as RouterLink, Navigate, useParams } from 'react-router-dom';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { reviewQueuePath } from '../../components/review/ReviewQueueList';
import type { ReviewQueueKey } from '../../config/reviewQueues';
import { REVIEW_QUEUES, findReviewQueue } from '../../config/reviewQueues';
import type { ResolvedReviewQueue } from '../../hooks/useReviewQueues';
import { useReviewQueues } from '../../hooks/useReviewQueues';

// Lazily imported HERE rather than in `App.tsx` so opening `/review` does not
// pull six unrelated page chunks in with it — only the queue actually opened is
// fetched. Each is a zero-prop default export.
const BurstsPage = lazy(() => import('../Bursts/BurstsPage'));
const DuplicatesPage = lazy(() => import('../Duplicates/DuplicatesPage'));
const LocationSuggestionsPage = lazy(
  () => import('../LocationSuggestions/LocationSuggestionsPage'),
);
const EnhancementsPage = lazy(() => import('../Enhancements/EnhancementsPage'));
const ReviewInsightsPage = lazy(() => import('../Insights/ReviewInsightsPage'));
const WorkflowListPage = lazy(() => import('../Workflows/WorkflowListPage'));

const QUEUE_PAGES: Record<ReviewQueueKey, React.ComponentType> = {
  bursts: BurstsPage,
  duplicates: DuplicatesPage,
  locations: LocationSuggestionsPage,
  enhancements: EnhancementsPage,
  insights: ReviewInsightsPage,
  automations: WorkflowListPage,
};

/**
 * Registry labels are plural ("Duplicates"), which reads wrong at a count of
 * one. Trimming the trailing "s" covers every label in the registry and is
 * cheaper than carrying a second noun per entry.
 */
function pluralize(label: string, count: number): string {
  const lower = label.toLowerCase();
  return count === 1 && lower.endsWith('s') ? lower.slice(0, -1) : lower;
}

/**
 * The next queue still holding work, in registry order, wrapping around and
 * skipping the current one. Secondary entries are not queues and never qualify.
 */
function nextNonEmpty(
  entries: ResolvedReviewQueue[],
  currentKey: ReviewQueueKey,
): ResolvedReviewQueue | null {
  const order = REVIEW_QUEUES.map((def) => def.key);
  const start = order.indexOf(currentKey);
  if (start < 0) return null;

  for (let step = 1; step <= order.length; step += 1) {
    const key = order[(start + step) % order.length];
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry && entry.group === 'queue' && entry.count !== null && entry.count > 0) {
      return entry;
    }
  }
  return null;
}

export default function ReviewQueuePage() {
  const { queue } = useParams<{ queue: string }>();
  const { entries, isLoading } = useReviewQueues();

  const def = findReviewQueue(queue);
  // `entries` holds ENABLED entries only, so this resolves the unknown-key and
  // feature-disabled cases with one lookup.
  const entry = def ? entries.find((candidate) => candidate.key === def.key) ?? null : null;

  if (!def) return <Navigate to="/review" replace />;
  if (!entry) {
    // Not enabled — but the flags may simply not have answered yet, and
    // bouncing a deep link to the hub a beat before the answer arrives would be
    // a bug the user experiences as a random redirect.
    if (isLoading) return <LoadingSpinner />;
    return <Navigate to="/review" replace />;
  }

  const QueueComponent = QUEUE_PAGES[entry.key];
  const drained = entry.group === 'queue' && entry.count === 0;
  const next = drained ? nextNonEmpty(entries, entry.key) : null;

  return (
    <Box sx={{ minWidth: 0 }}>
      <Button
        component={RouterLink}
        to="/review"
        startIcon={<ArrowBackIcon />}
        aria-label="Back to Review"
        size="small"
        sx={{ mb: 1 }}
      >
        Review
      </Button>

      <Suspense fallback={<LoadingSpinner />}>
        <QueueComponent />
      </Suspense>

      {/* Chain-to-next (spec §4.5 requirement 3): having finished this queue,
          offer the next one inline rather than making the user walk back to the
          hub to discover it. The counts are already loaded, so it costs nothing. */}
      {next && next.count !== null && (
        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
          <Button
            component={RouterLink}
            to={reviewQueuePath(next.key)}
            endIcon={<ArrowForwardIcon />}
            variant="outlined"
          >
            <Typography component="span" variant="button" noWrap>
              Next: {next.count} {pluralize(next.label, next.count)}
            </Typography>
          </Button>
        </Box>
      )}
    </Box>
  );
}
