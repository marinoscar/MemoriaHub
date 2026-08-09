/**
 * Home — the gallery, and nothing else.
 *
 * The three review-queue banners (pending bursts / duplicates / location
 * suggestions) were deleted here in issue #250, the Notification Center
 * cutover. They were the app's only push surface for pending review work, and
 * epic #240 replaced them with real notifications: the producer (#246) emits a
 * `review_queue_*` row per circle, the AppBar bell (#249) shows the count, and
 * `/notifications` (#250) is the inbox. Leaving the banners in place would have
 * meant two independent surfaces racing to report the same numbers.
 *
 * `useDashboard()` went with them. Those three counts were its ONLY consumer on
 * this page, so keeping the call would have left the app's busiest route paying
 * for a dashboard payload (On This Day + recent + favorites, each with signed
 * thumbnails) that nothing rendered. The hook was deleted outright in issue
 * #309; `GET /api/media/dashboard` and its `getDashboard()` client remain, and
 * are simply not what Home needs.
 *
 * ONE row was added back in issue #309 (epic #300): <MemoriesCarousel>. It is
 * not a return to the dashboard shape — it renders `null` whenever
 * `features.memories` is off (the default), no circle is active, or the feed is
 * empty, and it fires no request in any of those cases. A brand-new install
 * therefore sees this page exactly as it was.
 */

import { useMemo } from 'react';
import { Box, Alert, Link, Typography } from '@mui/material';
import { PhotoLibrary as PhotoLibraryIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../hooks/useCircle';
import { MediaGallery } from '../components/media/MediaGallery';
import { MemoriesCarousel } from '../components/memories/MemoriesCarousel';

export default function HomePage() {
  const { activeCircle, activeCircleId, activeCircleRole, loading: circleLoading } = useCircle();

  // Memoized query params — stable reference when circleId unchanged
  const mediaParams = useMemo(
    () => ({
      circleId: activeCircleId ?? undefined,
      sortBy: 'capturedAt' as const,
      sortOrder: 'desc' as const,
    }),
    [activeCircleId],
  );

  const showNoCircle = !activeCircle && !circleLoading;

  const emptyState = (
    <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
      <PhotoLibraryIcon sx={{ fontSize: 72, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        No photos here yet
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Upload your first photo or video to {activeCircle?.name} to get started.
        Use the Upload button in the toolbar.
      </Typography>
    </Box>
  );

  // No minHeight/pb on this Box — the Layout shell owns viewport height and
  // the BottomNav clearance (issue #237); duplicating either stacks dead
  // scroll space below the last row.
  return (
    <Box>
      {/* No active circle */}
      {showNoCircle && (
        <Box sx={{ p: { xs: 2, md: 3 } }}>
          <Alert severity="info">
            Select or create a circle to get started.{' '}
            <Link component={RouterLink} to="/circles" underline="always">
              Go to Circles
            </Link>
          </Alert>
        </Box>
      )}

      {/* Memories row — self-hiding; see the header comment. */}
      <MemoriesCarousel circleId={activeCircleId} />

      {/* Gallery — only rendered when a circle is active */}
      {activeCircle && (
        <MediaGallery
          circleId={activeCircle.id}
          activeCircleRole={activeCircleRole}
          queryParams={mediaParams}
          emptyState={emptyState}
        />
      )}
    </Box>
  );
}
