import React, { useState } from 'react';
import {
  Container,
  Box,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  Alert,
  CircularProgress,
  Divider,
  useTheme,
} from '@mui/material';
import {
  Storage as StorageIcon,
  Refresh as RefreshIcon,
  Insights as InsightsIcon,
  PhotoLibrary as PhotoIcon,
  Videocam as VideoIcon,
  Face as FaceIcon,
  LocalOffer as TagIcon,
} from '@mui/icons-material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useInsights } from '../../hooks/useInsights';
import { KpiCard } from '../../components/insights/KpiCard';
import { KpiSkeleton } from '../../components/insights/KpiSkeleton';
import { CompositionDonut } from '../../components/insights/CompositionDonut';
import { ProportionBar } from '../../components/insights/ProportionBar';
import { FreshnessPill } from '../../components/insights/FreshnessPill';
import { formatBytes, formatCompactNumber, percent, bytesToMB } from '../../utils/formatBytes';

// Suppress unused import warning — VideoIcon is available for future use
void VideoIcon;

// Accent palette — two-tone for photos/videos, plus individual KPI accents
const PHOTO_COLOR = '#3b82f6'; // blue
const VIDEO_COLOR = '#8b5cf6'; // violet

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function StorageInsightsPageContent() {
  const { data, loading, refreshing, error, refresh } = useInsights();
  const theme = useTheme();
  const [refreshSuccess, setRefreshSuccess] = useState(false);

  const handleRefresh = async () => {
    setRefreshSuccess(false);
    await refresh();
    setRefreshSuccess(true);
    setTimeout(() => setRefreshSuccess(false), 3000);
  };

  const m = data?.metrics;

  // Build chart data only when metrics are available
  const storageSegments = m
    ? [
        {
          label: 'Photos',
          value: bytesToMB(m.photoBytes),
          color: PHOTO_COLOR,
          displayValue: formatBytes(m.photoBytes),
          percentage: percent(m.photoBytes, m.totalBytes),
        },
        {
          label: 'Videos',
          value: bytesToMB(m.videoBytes),
          color: VIDEO_COLOR,
          displayValue: formatBytes(m.videoBytes),
          percentage: percent(m.videoBytes, m.totalBytes),
        },
      ]
    : [];

  const countSegments = m
    ? [
        {
          label: 'Photos',
          value: m.photoCount,
          color: PHOTO_COLOR,
          displayValue: formatCompactNumber(m.photoCount),
          percentage: percent(m.photoCount, m.totalItems),
        },
        {
          label: 'Videos',
          value: m.videoCount,
          color: VIDEO_COLOR,
          displayValue: formatCompactNumber(m.videoCount),
          percentage: percent(m.videoCount, m.totalItems),
        },
      ]
    : [];

  const proportionBarSegments = m
    ? [
        {
          label: 'Photos',
          value: percent(m.photoBytes, m.totalBytes),
          color: PHOTO_COLOR,
          displayValue: formatBytes(m.photoBytes),
        },
        {
          label: 'Videos',
          value: percent(m.videoBytes, m.totalBytes),
          color: VIDEO_COLOR,
          displayValue: formatBytes(m.videoBytes),
        },
      ]
    : [];

  return (
    <Container maxWidth="xl">
      <Box py={4}>
        {/* Header */}
        <Box
          display="flex"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          flexDirection={{ xs: 'column', sm: 'row' }}
          gap={2}
          mb={4}
        >
          <Box display="flex" alignItems="center" gap={1.5}>
            <InsightsIcon sx={{ fontSize: 32, color: 'primary.main' }} />
            <Box>
              <Typography variant="h5" fontWeight={700}>
                Storage Insights
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Across all circles
              </Typography>
            </Box>
          </Box>
          <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
            {data && (
              <FreshnessPill computedAt={data.computedAt} durationMs={data.durationMs} />
            )}
            <Button
              variant="contained"
              startIcon={refreshing ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
              disabled={refreshing}
              onClick={() => void handleRefresh()}
              color={refreshSuccess ? 'success' : 'primary'}
              size="small"
            >
              {refreshSuccess ? 'Updated!' : 'Refresh now'}
            </Button>
          </Box>
        </Box>

        {/* Error state */}
        {error && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void handleRefresh()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {/* Loading state */}
        {loading && <KpiSkeleton />}

        {/* Empty state */}
        {!loading && (!data || data.status === 'empty' || !m) && !error && (
          <Card variant="outlined" sx={{ borderRadius: 2 }}>
            <CardContent>
              <Box
                display="flex"
                flexDirection="column"
                alignItems="center"
                py={6}
                gap={2}
              >
                <StorageIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
                <Typography variant="h6" fontWeight={600} color="text.secondary">
                  No insights computed yet
                </Typography>
                <Typography variant="body2" color="text.disabled" textAlign="center" maxWidth={360}>
                  Run the first aggregation to see storage metrics across all circles.
                </Typography>
                <Button
                  variant="contained"
                  startIcon={refreshing ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                >
                  Compute now
                </Button>
              </Box>
            </CardContent>
          </Card>
        )}

        {/* Data loaded */}
        {!loading && m && (
          <Box display="flex" flexDirection="column" gap={4}>
            {/* Tier 1 — Hero KPIs */}
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Total Storage"
                  value={formatBytes(m.totalBytes)}
                  subLabel="across all circles"
                  icon={<StorageIcon />}
                  accentColor={theme.palette.primary.main}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Total Items"
                  value={formatCompactNumber(m.totalItems)}
                  subLabel={`${formatCompactNumber(m.photoCount)} photos · ${formatCompactNumber(m.videoCount)} videos`}
                  icon={<PhotoIcon />}
                  accentColor={PHOTO_COLOR}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Detected Faces"
                  value={formatCompactNumber(m.totalFaces)}
                  icon={<FaceIcon />}
                  accentColor="#f59e0b"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Tagged Items"
                  value={formatCompactNumber(m.taggedItems)}
                  subLabel={`${percent(m.taggedItems, m.totalItems).toFixed(1)}% coverage`}
                  icon={<TagIcon />}
                  accentColor="#10b981"
                />
              </Grid>
            </Grid>

            {/* Tier 2 — Composition */}
            <Card variant="outlined" sx={{ borderRadius: 2 }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="subtitle1" fontWeight={700} mb={3}>
                  Photos vs Videos
                </Typography>
                <Box
                  display="flex"
                  flexDirection={{ xs: 'column', md: 'row' }}
                  gap={4}
                  mb={3}
                >
                  <CompositionDonut
                    title="By storage"
                    segments={storageSegments}
                    centerLabel={formatBytes(m.totalBytes)}
                  />
                  <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />
                  <CompositionDonut
                    title="By count"
                    segments={countSegments}
                    centerLabel={formatCompactNumber(m.totalItems)}
                  />
                </Box>

                {/* Tier 3 — Proportion bar */}
                <Divider sx={{ mb: 2.5 }} />
                <ProportionBar
                  segments={proportionBarSegments}
                  caption="Storage breakdown by media type"
                />
              </CardContent>
            </Card>
          </Box>
        )}
      </Box>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Admin-gated export
// ---------------------------------------------------------------------------

export default function StorageInsightsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <StorageInsightsPageContent />;
}
