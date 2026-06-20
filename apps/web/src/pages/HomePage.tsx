import { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Alert,
  Button,
  Fab,
  Link,
  Typography,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  PhotoLibrary as PhotoLibraryIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../hooks/useCircle';
import { MediaUploadDialog } from '../components/media/MediaUploadDialog';
import { MediaGallery } from '../components/media/MediaGallery';

export default function HomePage() {
  const { activeCircle, activeCircleId, activeCircleRole, loading: circleLoading } = useCircle();

  // Upload dialog state
  const [uploadOpen, setUploadOpen] = useState(false);

  // Remount the gallery after upload so it refetches from page 1.
  // Incrementing this key causes React to unmount + remount MediaGallery.
  const [galleryKey, setGalleryKey] = useState(0);

  const handleUploadSuccess = useCallback(() => {
    setUploadOpen(false);
    setGalleryKey((k) => k + 1);
  }, []);

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
      </Typography>
      <Button variant="contained" startIcon={<UploadIcon />} onClick={() => setUploadOpen(true)}>
        Upload Media
      </Button>
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
          key={galleryKey}
          circleId={activeCircle.id}
          activeCircleRole={activeCircleRole}
          queryParams={mediaParams}
          emptyState={emptyState}
        />
      )}

      {/* Upload FAB */}
      {activeCircle && (
        <Fab
          color="primary"
          aria-label="Upload media"
          onClick={() => setUploadOpen(true)}
          sx={{ position: 'fixed', bottom: { xs: 72, sm: 24 }, right: 24, zIndex: 20 }}
        >
          <UploadIcon />
        </Fab>
      )}

      {/* Upload dialog */}
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircleId ?? undefined}
      />
    </Box>
  );
}
