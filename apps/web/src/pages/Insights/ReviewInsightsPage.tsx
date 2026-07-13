import {
  Box,
  Typography,
  Alert,
  Card,
  CardContent,
  Grid,
  Divider,
} from '@mui/material';
import {
  Insights as InsightsIcon,
  BurstMode as BurstModeIcon,
  ContentCopy as ContentCopyIcon,
  HourglassEmpty as PendingIcon,
  CheckCircle as ResolvedIcon,
  Cancel as DismissedIcon,
  PhotoLibrary as IdentifiedIcon,
} from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { useReviewInsights } from '../../hooks/useReviewInsights';
import { KpiCard } from '../../components/insights/KpiCard';
import { KpiSkeleton } from '../../components/insights/KpiSkeleton';
import { CompositionDonut } from '../../components/insights/CompositionDonut';
import { ProportionBar } from '../../components/insights/ProportionBar';
import { formatCompactNumber, percent } from '../../utils/formatBytes';
import type { ReviewQueueMetrics } from '../../services/reviewInsights';

// Outcome accent palette
const KEPT_COLOR = '#10b981'; // green
const ARCHIVED_COLOR = '#f59e0b'; // amber
const DELETED_COLOR = '#ef4444'; // red

interface QueueSectionProps {
  title: string;
  icon: React.ReactNode;
  accentColor: string;
  metrics: ReviewQueueMetrics;
}

function QueueSection({ title, icon, accentColor, metrics }: QueueSectionProps) {
  const outcomeTotal = metrics.itemsKept + metrics.itemsArchived + metrics.itemsDeleted;

  const outcomeSegments = [
    {
      label: 'Kept',
      value: metrics.itemsKept,
      color: KEPT_COLOR,
      displayValue: formatCompactNumber(metrics.itemsKept),
      percentage: percent(metrics.itemsKept, outcomeTotal),
    },
    {
      label: 'Archived',
      value: metrics.itemsArchived,
      color: ARCHIVED_COLOR,
      displayValue: formatCompactNumber(metrics.itemsArchived),
      percentage: percent(metrics.itemsArchived, outcomeTotal),
    },
    {
      label: 'Deleted',
      value: metrics.itemsDeleted,
      color: DELETED_COLOR,
      displayValue: formatCompactNumber(metrics.itemsDeleted),
      percentage: percent(metrics.itemsDeleted, outcomeTotal),
    },
  ];

  const removedTotal = metrics.itemsArchived + metrics.itemsDeleted;
  const proportionSegments = [
    {
      label: 'Archived',
      value: percent(metrics.itemsArchived, removedTotal),
      color: ARCHIVED_COLOR,
    },
    {
      label: 'Deleted',
      value: percent(metrics.itemsDeleted, removedTotal),
      color: DELETED_COLOR,
    },
  ];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ color: accentColor, display: 'flex' }}>{icon}</Box>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
      </Box>

      {/* KPI row */}
      <Grid container spacing={3}>
        <Grid size={{ xs: 6, sm: 6, lg: 3 }}>
          <KpiCard
            label="Identified"
            value={formatCompactNumber(metrics.identified)}
            subLabel="groups detected"
            icon={<IdentifiedIcon />}
            accentColor={accentColor}
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 6, lg: 3 }}>
          <KpiCard
            label="Pending"
            value={formatCompactNumber(metrics.pending)}
            subLabel="awaiting review"
            icon={<PendingIcon />}
            accentColor={ARCHIVED_COLOR}
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 6, lg: 3 }}>
          <KpiCard
            label="Resolved"
            value={formatCompactNumber(metrics.resolved)}
            subLabel="reviewed & applied"
            icon={<ResolvedIcon />}
            accentColor={KEPT_COLOR}
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 6, lg: 3 }}>
          <KpiCard
            label="Dismissed"
            value={formatCompactNumber(metrics.dismissed)}
            subLabel="marked not a match"
            icon={<DismissedIcon />}
            accentColor="#94a3b8"
          />
        </Grid>
      </Grid>

      {/* Outcome breakdown */}
      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>
            Outcome of reviewed photos
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
            How photos in resolved groups were handled
          </Typography>

          {outcomeTotal === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No groups have been resolved yet.
            </Typography>
          ) : (
            <Grid container spacing={3} sx={{ alignItems: 'center' }}>
              <Grid size={{ xs: 12, md: 5 }}>
                <CompositionDonut
                  title="Kept vs removed"
                  segments={outcomeSegments}
                  centerLabel={formatCompactNumber(outcomeTotal)}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 7 }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    {formatCompactNumber(metrics.itemsKept)} kept ·{' '}
                    {formatCompactNumber(metrics.itemsArchived)} archived ·{' '}
                    {formatCompactNumber(metrics.itemsDeleted)} deleted
                  </Typography>
                  <ProportionBar
                    segments={proportionSegments}
                    caption="Archived vs deleted (removed photos only)"
                  />
                </Box>
              </Grid>
            </Grid>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

export default function ReviewInsightsPage() {
  const { activeCircle, activeCircleId } = useCircle();
  const { data, loading, error } = useReviewInsights(activeCircleId ?? null);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view review insights.</Alert>
      </Box>
    );
  }

  const isEmpty =
    !loading &&
    data != null &&
    data.bursts.identified === 0 &&
    data.duplicates.identified === 0;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 4 }}>
        <InsightsIcon sx={{ fontSize: 32, color: 'primary.main' }} />
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            Review Insights
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Burst &amp; duplicate review activity for {activeCircle.name}
          </Typography>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <KpiSkeleton />
          <KpiSkeleton />
        </Box>
      )}

      {isEmpty && !error && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <InsightsIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No review activity yet
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Once burst or duplicate groups are detected and reviewed, their activity appears here.
          </Typography>
        </Box>
      )}

      {!loading && data && !isEmpty && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <QueueSection
            title="Bursts"
            icon={<BurstModeIcon />}
            accentColor="#3b82f6"
            metrics={data.bursts}
          />
          <Divider />
          <QueueSection
            title="Duplicates"
            icon={<ContentCopyIcon />}
            accentColor="#8b5cf6"
            metrics={data.duplicates}
          />
        </Box>
      )}
    </Box>
  );
}
