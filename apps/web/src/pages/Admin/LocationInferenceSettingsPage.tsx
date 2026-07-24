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
  Slider,
  Divider,
} from '@mui/material';
import { MyLocation as MyLocationIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalLocationInferenceBackfill } from '../../services/adminLocationInference';
import type { LocationInferenceBackfillResult } from '../../services/adminLocationInference';

function LocationInferenceSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  // Matching parameters local state
  const [maxGapMinutes, setMaxGapMinutes] = useState(30);
  const [maxExtrapolationGapMinutes, setMaxExtrapolationGapMinutes] = useState(10);
  const [autoApplyMaxGapMinutes, setAutoApplyMaxGapMinutes] = useState(5);
  const [requireSameDevice, setRequireSameDevice] = useState(true);
  const [maxAnchorDistanceKm, setMaxAnchorDistanceKm] = useState(2);
  const [maxImpliedSpeedKmh, setMaxImpliedSpeedKmh] = useState(150);
  const [bulkAcceptThreshold, setBulkAcceptThreshold] = useState(80);
  const [paramSaving, setParamSaving] = useState(false);

  // Backfill state
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<LocationInferenceBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Sync parameter fields from settings
  useEffect(() => {
    if (!settings) return;
    setMaxGapMinutes(settings.locationInference?.maxGapMinutes ?? 30);
    setMaxExtrapolationGapMinutes(settings.locationInference?.maxExtrapolationGapMinutes ?? 10);
    setAutoApplyMaxGapMinutes(settings.locationInference?.autoApplyMaxGapMinutes ?? 5);
    setRequireSameDevice(settings.locationInference?.requireSameDevice ?? true);
    setMaxAnchorDistanceKm(settings.locationInference?.maxAnchorDistanceKm ?? 2);
    setMaxImpliedSpeedKmh(settings.locationInference?.maxImpliedSpeedKmh ?? 150);
    setBulkAcceptThreshold(settings.locationInference?.bulkAcceptThreshold ?? 80);
  }, [settings]);

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({
      features: { ...(settings?.features ?? {}), locationInference: checked },
    }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  const handleSaveParams = () => {
    setParamSaving(true);
    updateSettings({
      locationInference: {
        maxGapMinutes,
        maxExtrapolationGapMinutes,
        autoApplyMaxGapMinutes,
        requireSameDevice,
        maxAnchorDistanceKm,
        maxImpliedSpeedKmh,
        bulkAcceptThreshold,
      },
    })
      .then(() => setSuccessMessage('Location inference parameters saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save parameters');
      })
      .finally(() => setParamSaving(false));
  };

  const handleRunBackfill = () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    runGlobalLocationInferenceBackfill({
      from: backfillFrom || undefined,
      to: backfillTo || undefined,
      force: backfillForce,
    })
      .then((result) => setBackfillResult(result))
      .catch((err: unknown) => {
        setBackfillError(err instanceof Error ? err.message : 'Global location inference scan failed');
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
          <MyLocationIcon color="primary" />
          <Typography variant="h4" component="h1">
            Location Inference
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Estimate missing GPS coordinates from nearby same-device photos, tune auto-apply
          thresholds, and trigger backfills across all circles.
        </Typography>

        {/* Section 1: Global Settings */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings?.features?.locationInference ?? false}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable location inference globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            Interpolates or extrapolates coordinates from timeline-adjacent photos taken by the same
            device. High-confidence results are auto-applied (and always revertible); everything else
            is sent to a confirm/adjust/reject review queue.
          </Typography>
        </Paper>

        {/* Section 2: Matching Parameters */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Inference Parameters
          </Typography>

          <Stack spacing={4} sx={{ mb: 2 }}>
            <Box>
              <Typography gutterBottom>
                Max interpolation gap: <strong>{maxGapMinutes} min</strong>
              </Typography>
              <Slider
                value={maxGapMinutes}
                onChange={(_, value) => setMaxGapMinutes(value as number)}
                min={1}
                max={1440}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Maximum time gap (1–1440 minutes) between two GPS anchors for interpolation between
                them to be attempted at all.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Max extrapolation gap: <strong>{maxExtrapolationGapMinutes} min</strong>
              </Typography>
              <Slider
                value={maxExtrapolationGapMinutes}
                onChange={(_, value) => setMaxExtrapolationGapMinutes(value as number)}
                min={1}
                max={240}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Tighter window (1–240 minutes) used when only a single GPS anchor is available
                (extrapolation is inherently less safe than interpolating between two).
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Auto-apply gap ceiling: <strong>{autoApplyMaxGapMinutes} min</strong>
              </Typography>
              <Slider
                value={autoApplyMaxGapMinutes}
                onChange={(_, value) => setAutoApplyMaxGapMinutes(value as number)}
                min={0}
                max={60}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Both anchor gaps must be within this window (0–60 minutes) for a high-confidence
                result to be written automatically. <strong>Setting this to 0 disables auto-apply
                entirely</strong> — every inference is sent to the review queue instead.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Max anchor disagreement: <strong>{maxAnchorDistanceKm.toFixed(1)} km</strong>
              </Typography>
              <Slider
                value={maxAnchorDistanceKm}
                onChange={(_, value) => setMaxAnchorDistanceKm(value as number)}
                min={0.1}
                max={100}
                step={0.1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Maximum distance (0.1–100 km) the before/after anchors may disagree by before
                interpolation is downgraded to a single nearer-in-time anchor.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Max implied speed: <strong>{maxImpliedSpeedKmh} km/h</strong>
              </Typography>
              <Slider
                value={maxImpliedSpeedKmh}
                onChange={(_, value) => setMaxImpliedSpeedKmh(value as number)}
                min={10}
                max={1000}
                step={5}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Speed gate (10–1000 km/h): if the distance and time between anchors imply a faster
                speed than this, the subject was likely traveling — the result is never auto-applied
                and its confidence is capped, regardless of how close the anchors are in time.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Bulk-accept confidence threshold: <strong>{bulkAcceptThreshold}</strong>
              </Typography>
              <Slider
                value={bulkAcceptThreshold}
                onChange={(_, value) => setBulkAcceptThreshold(value as number)}
                min={0}
                max={100}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Score 0–100 (default 80). The default confidence floor for the "Accept all
                &ge; N%" (high-confidence) and "Reject all &lt; N%" (low-confidence) bulk actions
                on the Location Suggestions review page.
              </Typography>
            </Box>

            <Divider />

            <Box>
              <FormControlLabel
                control={
                  <Switch
                    checked={requireSameDevice}
                    onChange={(e) => setRequireSameDevice(e.target.checked)}
                  />
                }
                label="Require matching camera make/model between anchors"
                sx={{ display: 'block' }}
              />
              <Typography variant="caption" color="text.secondary">
                When enabled (recommended), only photos from the same camera are used as anchors —
                items with no camera EXIF at all (e.g. WhatsApp re-shares, which strip metadata) are
                never inferable. Disabling this allows any-device anchors, but results are
                <strong> suggestion-only</strong> — auto-apply is disabled whenever the anchors don't
                share a device, since cross-device matches are inherently less trustworthy.
              </Typography>
            </Box>
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
            Scan All Circles for Missing Locations
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue one fast sweep job per eligible circle to fill in missing GPS coordinates from
            nearby same-device photos. Sweeps are pure-DB and typically complete in under a minute,
            even for libraries with tens of thousands of photos.
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
              <Switch checked={backfillForce} onChange={(e) => setBackfillForce(e.target.checked)} />
            }
            label="Force (recompute suggestions for already-processed photos)"
            sx={{ mb: 2, display: 'block' }}
          />

          {backfillResult && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {backfillResult.enqueued} sweep job{backfillResult.enqueued !== 1 ? 's' : ''} queued
              covering ~{backfillResult.estimatedItems} photo{backfillResult.estimatedItems !== 1 ? 's' : ''} across{' '}
              {backfillResult.circles} circle{backfillResult.circles !== 1 ? 's' : ''}.
            </Alert>
          )}
          {backfillError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setBackfillError(null)}>
              {backfillError}
            </Alert>
          )}

          <Button
            variant="contained"
            disabled={!(settings?.features?.locationInference) || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Run Global Location Scan
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

export default function LocationInferenceSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <LocationInferenceSettingsContent />;
}
