import React from 'react';
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
  Chip,
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
  HourglassEmpty as QueuedIcon,
  QueryStats as ComputingIcon,
} from '@mui/icons-material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useInsights } from '../../hooks/useInsights';
import { KpiCard } from '../../components/insights/KpiCard';
import { KpiSkeleton } from '../../components/insights/KpiSkeleton';
import { CompositionDonut } from '../../components/insights/CompositionDonut';
import { ProportionBar } from '../../components/insights/ProportionBar';
import { FreshnessPill } from '../../components/insights/FreshnessPill';
import { formatBytes, formatCompactNumber, percent, bytesToNumber } from '../../utils/formatBytes';

// Suppress unused import warning — VideoIcon is available for future use
void VideoIcon;

// Accent palette — two-tone for photos/videos, plus individual KPI accents
const PHOTO_COLOR = '#3b82f6'; // blue
const VIDEO_COLOR = '#8b5cf6'; // violet

// ---------------------------------------------------------------------------
// Tiny pluralization helper
// ---------------------------------------------------------------------------

function pluralize(n: number, word: string): string {
  return n === 1 ? `1 ${word}` : `${formatCompactNumber(n)} ${word}s`;
}

// ---------------------------------------------------------------------------
// Refresh button label derived from jobState
// ---------------------------------------------------------------------------

function refreshButtonLabel(jobState: string, refreshing: boolean): string {
  if (!refreshing) return 'Refresh now';
  if (jobState === 'pending') return 'Queued…';
  if (jobState === 'running') return 'Computing…';
  return 'Refreshing…';
}

// ---------------------------------------------------------------------------
// In-flight status indicator chip shown near the header
// ---------------------------------------------------------------------------

interface InFlightChipProps {
  jobState: string;
  refreshing: boolean;
}

function InFlightChip({ jobState, refreshing }: InFlightChipProps) {
  if (!refreshing) return null;

  const isPending = jobState === 'pending';
  const label = isPending ? 'Refresh queued' : 'Computing metrics…';
  const icon = isPending
    ? <QueuedIcon sx={{ fontSize: 14 }} />
    : <ComputingIcon sx={{ fontSize: 14 }} />;

  return (
    <Chip
      size="small"
      icon={icon}
      label={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          {label}
          <CircularProgress size={10} thickness={5} color="inherit" />
        </Box>
      }
      color="info"
      variant="outlined"
      sx={{ fontWeight: 500, '.MuiChip-label': { display: 'flex', alignItems: 'center' } }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function StorageInsightsPageContent() {
  const { data, loading, refreshing, jobState, error, refresh } = useInsights();
  const theme = useTheme();

  const handleRefresh = () => {
    void refresh();
  };

  const m = data?.metrics;

  // Build chart data only when metrics are available
  const storageSegments = m
    ? [
        {
          label: 'Photos',
          value: bytesToNumber(m.photoBytes),
          color: PHOTO_COLOR,
          displayValue: formatBytes(m.photoBytes),
          percentage: percent(m.photoBytes, m.totalBytes),
        },
        {
          label: 'Videos',
          value: bytesToNumber(m.videoBytes),
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
        },
        {
          label: 'Videos',
          value: percent(m.videoBytes, m.totalBytes),
          color: VIDEO_COLOR,
        },
      ]
    : [];

  // The empty state is the initial no-data state with no job in flight
  const showEmpty =
    !loading &&
    !refreshing &&
    (!data || data.status === 'empty' || !m) &&
    !error;

  // Show the empty card even while in-flight if there are no metrics yet,
  // but swap its button to a disabled "queued/computing" state
  const showEmptyWithInFlight =
    !loading &&
    refreshing &&
    (!data || data.status === 'empty' || !m) &&
    !error;

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 2,
            mb: 4,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
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
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
            {/* In-flight status chip — only visible while refreshing */}
            <InFlightChip jobState={jobState} refreshing={refreshing} />

            {/* Freshness pill — always reflects last computedAt */}
            {data && (
              <FreshnessPill computedAt={data.computedAt} durationMs={data.durationMs} />
            )}

            <Button
              variant="contained"
              startIcon={
                refreshing
                  ? <CircularProgress size={16} color="inherit" />
                  : <RefreshIcon />
              }
              disabled={refreshing}
              onClick={handleRefresh}
              size="small"
            >
              {refreshButtonLabel(jobState, refreshing)}
            </Button>
          </Box>
        </Box>

        {/* Failed-job error banner (distinct from network errors) */}
        {jobState === 'failed' && data?.refresh.lastError && !refreshing && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={handleRefresh}>
                Retry
              </Button>
            }
          >
            Refresh job failed: {data.refresh.lastError}
          </Alert>
        )}

        {/* Generic / network error state */}
        {error && jobState !== 'failed' && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={handleRefresh}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {/* Initial loading skeleton */}
        {loading && <KpiSkeleton />}

        {/* Empty state — no metrics and no in-flight job */}
        {showEmpty && (
          <Card variant="outlined" sx={{ borderRadius: 2 }}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  py: 6,
                  gap: 2,
                }}
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
                  startIcon={<RefreshIcon />}
                  onClick={handleRefresh}
                >
                  Compute now
                </Button>
              </Box>
            </CardContent>
          </Card>
        )}

        {/* Empty state while first job is in flight */}
        {showEmptyWithInFlight && (
          <Card variant="outlined" sx={{ borderRadius: 2 }}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  py: 6,
                  gap: 2,
                }}
              >
                <CircularProgress size={48} thickness={3} />
                <Typography variant="h6" fontWeight={600} color="text.secondary">
                  {jobState === 'pending' ? 'Job queued…' : 'Computing metrics…'}
                </Typography>
                <Typography variant="body2" color="text.disabled" textAlign="center" maxWidth={360}>
                  Your first storage snapshot is being computed. This page will update automatically when it finishes.
                </Typography>
              </Box>
            </CardContent>
          </Card>
        )}

        {/* Data loaded — KPIs update automatically as polling refreshes data */}
        {!loading && m && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                  subLabel={`${pluralize(m.photoCount, 'photo')} · ${pluralize(m.videoCount, 'video')}`}
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
                <Typography variant="subtitle1" fontWeight={700} mb={0.5}>
                  Photos vs Videos
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={3}>
                  How your library breaks down by media type
                </Typography>
                {/* Grid guarantees two-up on md+ and stacked on mobile;
                    each cell is centered so neither donut floats off to one side */}
                <Grid container spacing={3} alignItems="flex-start" mb={3}>
                  <Grid size={{ xs: 12, md: 6 }}>
                    <CompositionDonut
                      title="By storage"
                      segments={storageSegments}
                      centerLabel={formatBytes(m.totalBytes)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, md: 6 }}>
                    <CompositionDonut
                      title="By count"
                      segments={countSegments}
                      centerLabel={formatCompactNumber(m.totalItems)}
                    />
                  </Grid>
                </Grid>

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
