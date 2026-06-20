import { useMemo } from 'react';
import {
  Box,
  Alert,
  Link,
  Typography,
} from '@mui/material';
import {
  PhotoLibrary as PhotoLibraryIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../hooks/useCircle';
import { MediaGallery } from '../components/media/MediaGallery';

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
        No memories here yet
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Upload your first photo or video to {activeCircle?.name} to get started.
        Use the Upload button in the toolbar.
      </Typography>
    </Box>
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: { xs: 10, sm: 4 } }}>
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
