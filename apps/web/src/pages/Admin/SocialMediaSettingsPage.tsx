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
} from '@mui/material';
import { Movie as MovieIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { backfillSocialMedia, getSocialMediaStatus } from '../../services/adminSocialMedia';
import type { SocialMediaBackfillResult, SocialMediaOcrStatus } from '../../services/adminSocialMedia';

function SocialMediaSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  // OCR model status
  const [ocrStatus, setOcrStatus] = useState<SocialMediaOcrStatus | null>(null);
  const [ocrStatusError, setOcrStatusError] = useState<string | null>(null);
  const [ocrStatusLoading, setOcrStatusLoading] = useState(false);

  // OCR / detection parameters local state
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [minConfidence, setMinConfidence] = useState(0.7);
  const [ocrMaxFrames, setOcrMaxFrames] = useState(4);
  const [ocrTimeoutSeconds, setOcrTimeoutSeconds] = useState(60);
  const [ocrLanguages, setOcrLanguages] = useState('eng');
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(300);
  const [maxSizeBytes, setMaxSizeBytes] = useState(500_000_000);
  const [paramSaving, setParamSaving] = useState(false);

  // Backfill state
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<SocialMediaBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const loadStatus = () => {
    setOcrStatusLoading(true);
    setOcrStatusError(null);
    getSocialMediaStatus()
      .then(setOcrStatus)
      .catch((err: unknown) => {
        setOcrStatusError(err instanceof Error ? err.message : 'Failed to load OCR model status');
      })
      .finally(() => setOcrStatusLoading(false));
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // Sync parameter fields from settings
  useEffect(() => {
    if (!settings) return;
    setOcrEnabled(settings.socialMedia?.ocrEnabled ?? false);
    setMinConfidence(settings.socialMedia?.minConfidence ?? 0.7);
    setOcrMaxFrames(settings.socialMedia?.ocrMaxFrames ?? 4);
    setOcrTimeoutSeconds(settings.socialMedia?.ocrTimeoutSeconds ?? 60);
    setOcrLanguages((settings.socialMedia?.ocrLanguages ?? ['eng']).join(', '));
    setMaxDurationSeconds(settings.socialMedia?.maxDurationSeconds ?? 300);
    setMaxSizeBytes(settings.socialMedia?.maxSizeBytes ?? 500_000_000);
  }, [settings]);

  const featureEnabled = settings?.features?.socialMediaDetection ?? false;

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({
      features: { ...(settings?.features ?? {}), socialMediaDetection: checked },
    }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  const handleSaveParams = () => {
    const languages = ocrLanguages
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Guard to the backend-documented ranges before saving so an
    // out-of-range value never fails the whole PATCH.
    const clampedMaxDuration = Math.min(3600, Math.max(60, Math.round(maxDurationSeconds)));
    const clampedMaxSizeBytes = Math.max(10_000_000, Math.round(maxSizeBytes));

    setParamSaving(true);
    updateSettings({
      socialMedia: {
        ...(settings?.socialMedia ?? {}),
        ocrEnabled,
        minConfidence,
        ocrMaxFrames,
        ocrTimeoutSeconds,
        ocrLanguages: languages.length > 0 ? languages : ['eng'],
        maxDurationSeconds: clampedMaxDuration,
        maxSizeBytes: clampedMaxSizeBytes,
      },
    })
      .then(() => setSuccessMessage('Social media detection settings saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      })
      .finally(() => setParamSaving(false));
  };

  const handleRunBackfill = () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    backfillSocialMedia({
      from: backfillFrom || undefined,
      to: backfillTo || undefined,
      force: backfillForce,
    })
      .then((result) => setBackfillResult(result))
      .catch((err: unknown) => {
        setBackfillError(err instanceof Error ? err.message : 'Global social media scan failed');
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
          <MovieIcon color="primary" />
          <Typography variant="h4" component="h1">
            Social Media Detection
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Detects videos saved from TikTok, Instagram, and Facebook and tags them{' '}
          <strong>&ldquo;Social Media&rdquo;</strong> plus the source platform. Detected social media
          videos are skipped by all other enrichment (tagging, face detection, bursts, duplicates,
          location inference) to save compute.
        </Typography>

        {/* OCR model status */}
        {ocrStatusError && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" onClick={loadStatus} disabled={ocrStatusLoading}>
                Retry
              </Button>
            }
          >
            {ocrStatusError}
          </Alert>
        )}
        {ocrStatus && (
          <Alert
            severity={ocrStatus.degraded ? 'warning' : 'success'}
            sx={{ mb: 2 }}
            action={
              <Button
                color="inherit"
                size="small"
                startIcon={ocrStatusLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
                onClick={loadStatus}
                disabled={ocrStatusLoading}
              >
                Refresh
              </Button>
            }
          >
            {ocrStatus.degraded
              ? `OCR model unavailable — running Tier-1 (metadata) detection only. Tier-2 on-frame text OCR is disabled. Model path: ${ocrStatus.modelPath}`
              : `OCR model is loaded and available (languages: ${ocrStatus.languages.join(', ') || 'none'}). Model path: ${ocrStatus.modelPath}`}
          </Alert>
        )}

        {/* Section 1: Global Settings */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={featureEnabled}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable social media detection globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            When enabled, uploaded videos are checked against known social media signatures. Matches
            are tagged &ldquo;Social Media&rdquo; and the source platform, and are excluded from all
            other enrichment jobs.
          </Typography>
        </Paper>

        {/* Section 2: OCR & Detection Parameters */}
        <Paper
          variant="outlined"
          sx={{ p: 3, mb: 2, opacity: featureEnabled ? 1 : 0.6 }}
        >
          <Typography variant="h6" sx={{ mb: 2 }}>
            OCR &amp; Detection Parameters
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={ocrEnabled}
                onChange={(e) => setOcrEnabled(e.target.checked)}
                disabled={!featureEnabled}
              />
            }
            label="Enable OCR (Tier 2)"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Tier 2 reads on-frame text (e.g. usernames, watermarks) to confirm the source platform
            when metadata alone (Tier 1) is inconclusive.
          </Typography>

          <Stack spacing={4} sx={{ mb: 2 }}>
            <Box>
              <Typography gutterBottom>
                Minimum confidence: <strong>{minConfidence.toFixed(2)}</strong>
              </Typography>
              <Slider
                value={minConfidence}
                onChange={(_, value) => setMinConfidence(value as number)}
                min={0.5}
                max={1.0}
                step={0.01}
                valueLabelDisplay="auto"
                disabled={!featureEnabled}
              />
              <Typography variant="caption" color="text.secondary">
                Minimum detection confidence (0.50–1.00) required to classify a video as social media.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                OCR max frames: <strong>{ocrMaxFrames}</strong>
              </Typography>
              <Slider
                value={ocrMaxFrames}
                onChange={(_, value) => setOcrMaxFrames(value as number)}
                min={2}
                max={6}
                step={1}
                marks
                valueLabelDisplay="auto"
                disabled={!featureEnabled}
              />
              <Typography variant="caption" color="text.secondary">
                Number of frames sampled per video for OCR (2–6). More frames improves accuracy at
                the cost of compute.
              </Typography>
            </Box>

            <Box>
              <TextField
                label="OCR timeout (seconds)"
                type="number"
                size="small"
                value={ocrTimeoutSeconds}
                onChange={(e) => setOcrTimeoutSeconds(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 10, max: 300, step: 1 } }}
                disabled={!featureEnabled}
                sx={{ maxWidth: 240 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Maximum time (10–300 s) allowed for OCR on a single video before it is skipped.
              </Typography>
            </Box>

            <Box>
              <TextField
                label="OCR languages"
                size="small"
                fullWidth
                value={ocrLanguages}
                onChange={(e) => setOcrLanguages(e.target.value)}
                placeholder="eng, spa"
                disabled={!featureEnabled}
                sx={{ maxWidth: 360 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Comma-separated Tesseract language codes (e.g. <code>eng, spa</code>). Defaults to{' '}
                <code>eng</code>.
              </Typography>
            </Box>

            <Box>
              <TextField
                label="Max video duration (seconds)"
                type="number"
                size="small"
                value={maxDurationSeconds}
                onChange={(e) => setMaxDurationSeconds(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 60, max: 3600, step: 1 } }}
                disabled={!featureEnabled}
                sx={{ maxWidth: 240 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Videos longer than this (60–3600 s) are treated as clean without downloading or OCR —
                genuine social-media clips never exceed ~5 minutes.
              </Typography>
            </Box>

            <Box>
              <TextField
                label="Max video size (MB)"
                type="number"
                size="small"
                value={Math.round(maxSizeBytes / 1_000_000)}
                onChange={(e) => setMaxSizeBytes(Number(e.target.value) * 1_000_000)}
                slotProps={{ htmlInput: { min: 10, step: 1 } }}
                disabled={!featureEnabled}
                sx={{ maxWidth: 240 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Size fallback (minimum 10 MB) used only when a video&rsquo;s duration is unknown; larger
                videos are skipped as clean.
              </Typography>
            </Box>
          </Stack>

          <Button
            variant="contained"
            disabled={isSaving || paramSaving || !settings || !featureEnabled}
            startIcon={paramSaving ? <CircularProgress size={16} /> : undefined}
            onClick={handleSaveParams}
          >
            Save Parameters
          </Button>
        </Paper>

        {/* Section 3: Global Backfill */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Scan All Circles for Social Media Videos
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue social media detection across every circle. Only existing videos are scanned.
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
            label="Force (re-scan already-processed videos)"
            sx={{ mb: 2, display: 'block' }}
          />

          {backfillResult && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {backfillResult.enqueued} job{backfillResult.enqueued !== 1 ? 's' : ''} queued across{' '}
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
            disabled={!featureEnabled || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Run Global Social Media Scan
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

export default function SocialMediaSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <SocialMediaSettingsContent />;
}
