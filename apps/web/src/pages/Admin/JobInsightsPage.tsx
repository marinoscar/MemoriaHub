import {
  Container,
  Box,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  Alert,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  useTheme,
} from '@mui/material';
import {
  HourglassEmpty,
  Schedule,
  Replay,
  Refresh as RefreshIcon,
  ErrorOutlined,
  Speed,
  Timeline,
  QueryStats,
  PlayCircleOutlined,
} from '@mui/icons-material';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useJobInsights } from '../../hooks/useJobInsights';
import { KpiCard } from '../../components/insights/KpiCard';
import { KpiSkeleton } from '../../components/insights/KpiSkeleton';
import { ProportionBar } from '../../components/insights/ProportionBar';
import { FreshnessPill } from '../../components/insights/FreshnessPill';
import { formatDuration } from '../../utils/formatBytes';
import type {
  JobInsightsLiveByType,
  JobInsightsHistoryByType,
  JobInsightsEtaPerType,
} from '../../services/jobInsights';

// ---------------------------------------------------------------------------
// Color palette for proportion bar segments
// ---------------------------------------------------------------------------

const SEGMENT_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#84cc16',
  '#f97316',
];

// ---------------------------------------------------------------------------
// Per-type row data (joined from three sources)
// ---------------------------------------------------------------------------

interface PerTypeRow {
  type: string;
  queued: number;
  avgMs: number | null;
  p95Ms: number | null;
  throughputPerMin: number | null;
  etcMs: number | null;
}

function buildPerTypeRows(
  liveByType: JobInsightsLiveByType[],
  historyByType: JobInsightsHistoryByType[],
  etaPerType: JobInsightsEtaPerType[],
): PerTypeRow[] {
  // Build a map of all types
  const allTypes = new Set<string>();
  liveByType.forEach((r) => allTypes.add(r.type));
  historyByType.forEach((r) => allTypes.add(r.type));
  etaPerType.forEach((r) => allTypes.add(r.type));

  const rows: PerTypeRow[] = Array.from(allTypes).map((type) => {
    const live = liveByType.find((r) => r.type === type);
    const hist = historyByType.find((r) => r.type === type);
    const eta = etaPerType.find((r) => r.type === type);

    const queued = (live?.pending ?? 0) + (live?.running ?? 0);

    return {
      type,
      queued,
      avgMs: hist?.avgMs ?? null,
      p95Ms: hist?.p95Ms ?? null,
      throughputPerMin: hist?.throughputPerMin ?? null,
      etcMs: eta?.etcMs ?? null,
    };
  });

  // Sort by queued descending, then type ascending
  rows.sort((a, b) => {
    if (b.queued !== a.queued) return b.queued - a.queued;
    return a.type.localeCompare(b.type);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function JobInsightsPageContent() {
  const { data, loading, error, refresh } = useJobInsights();
  const theme = useTheme();

  const handleRefresh = () => {
    void refresh();
  };

  const isEmpty =
    !loading &&
    !error &&
    (!data || (data.live.total === 0 && data.history.overall.samples === 0));

  const perTypeRows =
    data
      ? buildPerTypeRows(
          data.live.byType,
          data.history.byType,
          data.eta.perType,
        )
      : [];

  const proportionSegments = data
    ? data.eta.perType
        .filter((p) => p.remaining > 0)
        .map((p, i) => ({
          label: p.type,
          value: (p.remaining / Math.max(data.eta.totalRemaining, 1)) * 100,
          color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
        }))
    : [];

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Back link */}
        <Link
          component={RouterLink}
          to="/admin/settings"
          underline="hover"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; Back to Settings
        </Link>

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
            <QueryStats sx={{ fontSize: 32, color: 'primary.main' }} />
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                Job Queue Insights
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Across all enrichment job types
              </Typography>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
            {data && (
              <FreshnessPill computedAt={data.computedAt} durationMs={null} />
            )}
            <Button
              variant="contained"
              startIcon={<RefreshIcon />}
              onClick={handleRefresh}
              disabled={loading}
              size="small"
            >
              Refresh now
            </Button>
          </Box>
        </Box>

        {/* Error state */}
        {error && (
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

        {/* Empty state */}
        {isEmpty && (
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
                <QueryStats sx={{ fontSize: 56, color: 'text.disabled' }} />
                <Typography variant="h6" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                  No jobs in the queue yet
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: 'text.disabled', textAlign: 'center', maxWidth: 360 }}
                >
                  Job queue insights will appear here once enrichment jobs have been processed.
                </Typography>
              </Box>
            </CardContent>
          </Card>
        )}

        {/* Data loaded */}
        {!loading && data && !isEmpty && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* Tier 1 — Hero KPIs row 1 */}
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="ETC"
                  value={
                    data.eta.basis === 'none'
                      ? 'Not enough history'
                      : formatDuration(data.eta.etaMs)
                  }
                  subLabel={`${data.eta.totalRemaining} job${data.eta.totalRemaining !== 1 ? 's' : ''} remaining`}
                  icon={<HourglassEmpty />}
                  accentColor="#3b82f6"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Avg Duration"
                  value={formatDuration(data.history.overall.avgMs)}
                  subLabel={`p50 ${formatDuration(data.history.overall.p50Ms)} · p95 ${formatDuration(data.history.overall.p95Ms)}`}
                  icon={<Timeline />}
                  accentColor="#10b981"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Pending"
                  value={String(data.live.pending)}
                  icon={<Schedule />}
                  accentColor="#f59e0b"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Running"
                  value={String(data.live.running)}
                  icon={<PlayCircleOutlined />}
                  accentColor="#8b5cf6"
                />
              </Grid>
            </Grid>

            {/* Tier 1 — Hero KPIs row 2 */}
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Failed"
                  value={String(data.live.failed)}
                  icon={<ErrorOutlined />}
                  accentColor={theme.palette.error.main}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Rate-limited"
                  value={String(data.live.rateLimited)}
                  icon={<Speed />}
                  accentColor="#f59e0b"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Backing off"
                  value={String(data.live.scheduled)}
                  icon={<Schedule />}
                  accentColor="#64748b"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                <KpiCard
                  label="Retried"
                  value={String(data.live.retried)}
                  icon={<Replay />}
                  accentColor="#0ea5e9"
                />
              </Grid>
            </Grid>

            {/* Tier 2 — Per-type table */}
            <Card variant="outlined" sx={{ borderRadius: 2 }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>
                  Per-type breakdown
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                  Duration statistics and estimated completion times by job type
                </Typography>

                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Type</TableCell>
                        <TableCell align="right">Queued</TableCell>
                        <TableCell align="right">Avg Duration</TableCell>
                        <TableCell align="right">p95</TableCell>
                        <TableCell align="right">Throughput</TableCell>
                        <TableCell align="right">ETC</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {perTypeRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                            No per-type data available
                          </TableCell>
                        </TableRow>
                      ) : (
                        perTypeRows.map((row) => (
                          <TableRow key={row.type} hover>
                            <TableCell>
                              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                {row.type}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography variant="body2">
                                {row.queued > 0 ? row.queued : '—'}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography variant="body2">
                                {formatDuration(row.avgMs)}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography variant="body2">
                                {formatDuration(row.p95Ms)}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography variant="body2">
                                {row.throughputPerMin !== null && row.throughputPerMin > 0
                                  ? `${row.throughputPerMin.toFixed(1)}/min`
                                  : '—'}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography variant="body2">
                                {formatDuration(row.etcMs)}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>

                {/* Tier 3 — ProportionBar */}
                {proportionSegments.length > 0 && (
                  <Box sx={{ mt: 3 }}>
                    <ProportionBar
                      segments={proportionSegments}
                      caption="Backlog by job type"
                    />
                  </Box>
                )}
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

export default function JobInsightsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <JobInsightsPageContent />;
}
