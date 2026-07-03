import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Chip,
  Stack,
  Button,
  CircularProgress,
  Alert,
  Link,
} from '@mui/material';
import {
  MonitorHeart as MonitorHeartIcon,
  Refresh as RefreshIcon,
  CheckCircle as CheckCircleIcon,
  WarningAmber as WarningAmberIcon,
  Error as ErrorIcon,
  RemoveCircleOutlined as RemoveCircleOutlineIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useDoctor } from '../../hooks/useDoctor';
import type { DoctorCheck, DoctorCheckStatus, DoctorSection } from '../../services/doctor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  DoctorCheckStatus,
  {
    icon: React.ReactElement;
    chipColor: 'success' | 'warning' | 'error' | 'default';
    alertSeverity: 'success' | 'warning' | 'error' | 'info';
  }
> = {
  ok: { icon: <CheckCircleIcon color="success" />, chipColor: 'success', alertSeverity: 'success' },
  warning: { icon: <WarningAmberIcon color="warning" />, chipColor: 'warning', alertSeverity: 'warning' },
  error: { icon: <ErrorIcon color="error" />, chipColor: 'error', alertSeverity: 'error' },
  skipped: { icon: <RemoveCircleOutlineIcon color="disabled" />, chipColor: 'default', alertSeverity: 'info' },
};

function StatusChip({ status }: { status: DoctorCheckStatus }) {
  return (
    <Chip
      label={status}
      color={STATUS_META[status]?.chipColor ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

function CheckRow({ check }: { check: DoctorCheck }) {
  const meta = STATUS_META[check.status];
  return (
    <Box sx={{ mb: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {meta.icon}
        <Typography component="span" sx={{ fontWeight: 600 }}>
          {check.label}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {check.message}
        </Typography>
      </Box>
      {check.actionItem && (
        <Alert severity={meta.alertSeverity} sx={{ mt: 1 }}>
          {check.actionItem}
        </Alert>
      )}
    </Box>
  );
}

function SectionCard({ section }: { section: DoctorSection }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Typography variant="h6">{section.label}</Typography>
        <StatusChip status={section.status} />
      </Box>
      {section.checks.map((check) => (
        <CheckRow key={check.key} check={check} />
      ))}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function DoctorPageContent() {
  const { report, loading, error, run } = useDoctor();

  if (loading && !report) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !report) {
    return (
      <Alert severity="error" sx={{ m: 3 }}>
        {error}
      </Alert>
    );
  }

  const summary = report?.summary;
  const overallStatus =
    summary && summary.error > 0
      ? { label: 'Unhealthy', color: 'error' as const }
      : summary && summary.warning > 0
      ? { label: 'Needs attention', color: 'warning' as const }
      : { label: 'Healthy', color: 'success' as const };

  return (
    <Container maxWidth="lg">
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

        {/* Page header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1,
            mb: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <MonitorHeartIcon color="primary" />
            <Typography variant="h4" component="h1">
              Doctor &mdash; Diagnostics
            </Typography>
          </Box>
          <Button
            variant="contained"
            onClick={() => void run()}
            disabled={loading}
            startIcon={loading ? <CircularProgress size={16} /> : <RefreshIcon />}
          >
            Run diagnostics
          </Button>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Run configuration health checks across auth, storage, AI providers, and background jobs.
        </Typography>

        {/* Inline error (report already loaded, a re-run failed) */}
        {error && report && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {report && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Computed {new Date(report.computedAt).toLocaleString()} &middot; {report.durationMs} ms
            </Typography>

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ mb: 3, flexWrap: 'wrap' }}
            >
              <Chip label={overallStatus.label} color={overallStatus.color} />
              <Chip label={`OK: ${summary!.ok}`} color="success" variant="outlined" />
              <Chip label={`Warning: ${summary!.warning}`} color="warning" variant="outlined" />
              <Chip label={`Error: ${summary!.error}`} color="error" variant="outlined" />
              <Chip label={`Skipped: ${summary!.skipped}`} color="default" variant="outlined" />
            </Stack>

            {report.sections.map((section) => (
              <SectionCard key={section.key} section={section} />
            ))}
          </>
        )}
      </Box>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Admin-gated export (mirrors JobsPage / FaceSettingsPage pattern)
// ---------------------------------------------------------------------------

export default function DoctorPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <DoctorPageContent />;
}
