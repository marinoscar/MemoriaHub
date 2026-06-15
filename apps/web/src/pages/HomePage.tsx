import { useState } from 'react';
import {
  Box,
  Container,
  Typography,
  Grid,
  Alert,
  Skeleton,
  Card,
  CardContent,
  Button,
  Link,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { CloudUpload as UploadIcon } from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { useCircle } from '../hooks/useCircle';
import { useDashboard } from '../hooks/useDashboard';
import { OnThisDay } from '../components/home/OnThisDay';
import { MemoryHighlights } from '../components/home/MemoryHighlights';
import { ReviewQueueCard } from '../components/home/ReviewQueueCard';
import { QuickActions } from '../components/home/QuickActions';
import { MediaDetailDrawer } from '../components/media/MediaDetailDrawer';
import { MediaUploadDialog } from '../components/media/MediaUploadDialog';
import type { MediaItem } from '../types/media';

export default function HomePage() {
  const { user } = useAuth();
  const { activeCircle, activeCircleId, loading: circleLoading } = useCircle();
  const { data: dashboard, isLoading: dashboardLoading, error: dashboardError, refetch } = useDashboard();

  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const handleMemorySelect = (item: MediaItem) => {
    setSelectedItem(item);
    setDrawerOpen(true);
  };

  const handleDrawerClose = () => {
    setDrawerOpen(false);
  };

  const handleItemUpdated = (updated: MediaItem) => {
    setSelectedItem(updated);
  };

  const handleUploadSuccess = () => {
    setUploadOpen(false);
    refetch();
  };

  const emptyCounts = { unreviewed: 0, lowValue: 0, missingGeo: 0 };

  const showSkeletons = dashboardLoading || circleLoading;
  const showNoCircle = !activeCircle && !circleLoading;
  const showEmptyState =
    activeCircle && !dashboardLoading && dashboard?.counts.total === 0;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Header */}
        <Typography variant="h4" component="h1" gutterBottom>
          Welcome back{user?.displayName ? `, ${user.displayName}` : ''}
        </Typography>
        {activeCircle && (
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            {activeCircle.name}
          </Typography>
        )}

        {/* No active circle */}
        {showNoCircle && (
          <Alert severity="info" sx={{ mb: 3 }}>
            Select or create a circle to get started.{' '}
            <Link component={RouterLink} to="/circles" underline="always">
              Go to Circles
            </Link>
          </Alert>
        )}

        {/* Empty state — circle exists but no media */}
        {showEmptyState && (
          <Card sx={{ mb: 3 }}>
            <CardContent sx={{ textAlign: 'center', py: 6 }}>
              <Typography variant="h6" gutterBottom>
                No memories here yet
              </Typography>
              <Typography color="text.secondary" sx={{ mb: 3 }}>
                Upload your first photo or video to {activeCircle?.name} to get started.
              </Typography>
              <Button
                variant="contained"
                startIcon={<UploadIcon />}
                onClick={() => setUploadOpen(true)}
              >
                Upload Media
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Error state — non-fatal, shown below content */}
        {dashboardError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {dashboardError}
          </Alert>
        )}

        {/* Skeletons while loading */}
        {showSkeletons && (
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, md: 4 }}>
              <Skeleton variant="rectangular" height={180} sx={{ borderRadius: 1 }} />
              <Skeleton variant="rectangular" height={180} sx={{ borderRadius: 1, mt: 2 }} />
            </Grid>
            <Grid size={{ xs: 12, md: 8 }}>
              <Skeleton variant="rectangular" height={160} sx={{ borderRadius: 1 }} />
              <Skeleton variant="rectangular" height={200} sx={{ borderRadius: 1, mt: 3 }} />
            </Grid>
          </Grid>
        )}

        {/* Main dashboard layout */}
        {!showSkeletons && activeCircle && (
          <Grid container spacing={3}>
            {/* Left column: review queue + quick actions */}
            <Grid size={{ xs: 12, md: 4 }}>
              <ReviewQueueCard counts={dashboard?.counts ?? emptyCounts} />
              <Box sx={{ mt: 2 }}>
                <QuickActions onUploadClick={() => setUploadOpen(true)} />
              </Box>
            </Grid>

            {/* Right column: on this day + highlights */}
            <Grid size={{ xs: 12, md: 8 }}>
              <OnThisDay
                items={dashboard?.onThisDay ?? []}
                onSelect={handleMemorySelect}
              />
              <Box sx={{ mt: 3 }}>
                <MemoryHighlights
                  recent={dashboard?.recent ?? []}
                  favorites={dashboard?.favorites ?? []}
                  onSelect={handleMemorySelect}
                />
              </Box>
            </Grid>
          </Grid>
        )}

        {/* When no circle: still show quick actions so user can navigate */}
        {!circleLoading && !activeCircle && (
          <Box sx={{ mt: 2 }}>
            <QuickActions onUploadClick={() => setUploadOpen(true)} />
          </Box>
        )}
      </Box>

      {/* Drawers / dialogs */}
      <MediaDetailDrawer
        item={selectedItem}
        open={drawerOpen}
        onClose={handleDrawerClose}
        onItemUpdated={handleItemUpdated}
      />
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircleId ?? undefined}
      />
    </Container>
  );
}
