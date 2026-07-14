import { useState, useEffect } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  Switch,
  FormControlLabel,
  CircularProgress,
  Alert,
  Snackbar,
  Link,
} from '@mui/material';
import { BurstMode as BurstModeIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalBurstBackfill } from '../../services/adminBackfill';
import type { GlobalBackfillResult } from '../../services/adminBackfill';

function BurstsSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  // Burst parameters local state
  const [timeGapSeconds, setTimeGapSeconds] = useState('');
  const [hashDistance, setHashDistance] = useState('');
  const [minGroupSize, setMinGroupSize] = useState('');
  const [autoResolveThreshold, setAutoResolveThreshold] = useState('');
  const [paramSaving, setParamSaving] = useState(false);

  // Backfill state
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<GlobalBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Sync parameter fields from settings
  useEffect(() => {
    if (!settings) return;
    setTimeGapSeconds(String(settings.burst?.timeGapSeconds ?? 10));
    setHashDistance(String(settings.burst?.hashDistance ?? 10));
    setMinGroupSize(String(settings.burst?.minGroupSize ?? 3));
    setAutoResolveThreshold(String(settings.burst?.autoResolveThreshold ?? 60));
  }, [settings]);

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({
      features: { ...(settings?.features ?? {}), burstDetection: checked },
    }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  const handleSaveParams = () => {
    setParamSaving(true);
    updateSettings({
      burst: {
        timeGapSeconds: Number(timeGapSeconds),
        hashDistance: Number(hashDistance),
        minGroupSize: Number(minGroupSize),
        autoResolveThreshold: Number(autoResolveThreshold),
      },
    })
      .then(() => setSuccessMessage('Burst detection parameters saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save parameters');
      })
      .finally(() => setParamSaving(false));
  };

  const handleRunBackfill = () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    runGlobalBurstBackfill({
      from: backfillFrom || undefined,
      to: backfillTo || undefined,
      force: backfillForce,
    })
      .then((result) => setBackfillResult(result))
      .catch((err: unknown) => {
        setBackfillError(err instanceof Error ? err.message : 'Global burst scan failed');
      })
      .finally(() => setBackfillLoading(false));
  };

  if (!settings && !error) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !settings) {
    return (
      <Alert severity="error" sx={{ m: 3 }}>
        {error}
      </Alert>
    );
  }

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

        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <BurstModeIcon color="primary" />
          <Typography variant="h4" component="h1">
            Bursts &amp; Similar Pictures
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Control burst photo detection globally and trigger backfills across all circles.
        </Typography>

        {/* Section 1: Global Settings */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings?.features?.burstDetection ?? false}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable burst photo detection globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            Groups near-duplicate photos taken within a short time window for review. Per-circle
            opt-in still applies.
          </Typography>
        </Paper>

        {/* Section 2: Burst Detection Parameters */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Burst Detection Parameters
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="Time gap (seconds)"
              type="number"
              size="small"
              value={timeGapSeconds}
              onChange={(e) => setTimeGapSeconds(e.target.value)}
              helperText="Max gap between two photos to be considered a burst. 1-300."
              slotProps={{ htmlInput: { min: 1, max: 300 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Hash distance (bits)"
              type="number"
              size="small"
              value={hashDistance}
              onChange={(e) => setHashDistance(e.target.value)}
              helperText="Max Hamming distance for visual similarity. 0-32."
              slotProps={{ htmlInput: { min: 0, max: 32 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Min group size"
              type="number"
              size="small"
              value={minGroupSize}
              onChange={(e) => setMinGroupSize(e.target.value)}
              helperText="Minimum photos to surface in review queue. 2-20."
              slotProps={{ htmlInput: { min: 2, max: 20 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Auto-resolve threshold"
              type="number"
              size="small"
              value={autoResolveThreshold}
              onChange={(e) => setAutoResolveThreshold(e.target.value)}
              helperText="Score 0–100 (default 60). Drives the 'resolve above N' buttons on the review page."
              slotProps={{ htmlInput: { min: 0, max: 100 } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <Button
            variant="contained"
            disabled={isSaving || paramSaving || !settings}
            startIcon={paramSaving ? <CircularProgress size={16} /> : undefined}
            onClick={handleSaveParams}
          >
            Save Parameters
          </Button>
        </Paper>

        {/* Section 3: Global Backfill */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Scan All Circles for Bursts
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue burst detection across every circle that has burst detection enabled.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="From date"
              type="date"
              size="small"
              value={backfillFrom}
              onChange={(e) => setBackfillFrom(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="To date"
              type="date"
              size="small"
              value={backfillTo}
              onChange={(e) => setBackfillTo(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <FormControlLabel
            control={
              <Switch
                checked={backfillForce}
                onChange={(e) => setBackfillForce(e.target.checked)}
              />
            }
            label="Force (reprocess already-scanned photos)"
            sx={{ mb: 2, display: 'block' }}
          />

          {backfillResult && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {backfillResult.enqueued} jobs queued across {backfillResult.circles} circle(s).
            </Alert>
          )}
          {backfillError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setBackfillError(null)}>
              {backfillError}
            </Alert>
          )}

          <Button
            variant="contained"
            disabled={!(settings?.features?.burstDetection) || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Run Global Burst Scan
          </Button>
        </Paper>
      </Box>

      {/* Success Snackbar */}
      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      {/* Error Snackbar */}
      <Snackbar open={!!localError} autoHideDuration={5000} onClose={() => setLocalError(null)}>
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default function BurstsSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <BurstsSettingsContent />;
}
