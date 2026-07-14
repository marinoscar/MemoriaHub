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
import { ContentCopy as ContentCopyIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalDuplicatesBackfill, getDuplicatesStatus } from '../../services/adminDuplicates';
import type { DuplicateBackfillResult, DuplicatesModelStatus } from '../../services/adminDuplicates';

function DuplicatesSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  // Model status
  const [modelStatus, setModelStatus] = useState<DuplicatesModelStatus | null>(null);
  const [modelStatusError, setModelStatusError] = useState<string | null>(null);

  // Matching parameters local state
  const [similarityThreshold, setSimilarityThreshold] = useState(0.96);
  const [hashMaxDistance, setHashMaxDistance] = useState(6);
  const [knnCandidates, setKnnCandidates] = useState(20);
  const [autoResolveThreshold, setAutoResolveThreshold] = useState(60);
  const [paramSaving, setParamSaving] = useState(false);

  // Backfill state
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<DuplicateBackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    getDuplicatesStatus()
      .then(setModelStatus)
      .catch((err: unknown) => {
        setModelStatusError(err instanceof Error ? err.message : 'Failed to load model status');
      });
  }, []);

  // Sync parameter fields from settings
  useEffect(() => {
    if (!settings) return;
    setSimilarityThreshold(settings.dedup?.similarityThreshold ?? 0.96);
    setHashMaxDistance(settings.dedup?.hashMaxDistance ?? 6);
    setKnnCandidates(settings.dedup?.knnCandidates ?? 20);
    setAutoResolveThreshold(settings.dedup?.autoResolveThreshold ?? 60);
  }, [settings]);

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({
      features: { ...(settings?.features ?? {}), duplicateDetection: checked },
    }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  const handleSaveParams = () => {
    setParamSaving(true);
    updateSettings({
      dedup: {
        similarityThreshold,
        hashMaxDistance,
        knnCandidates,
        autoResolveThreshold,
      },
    })
      .then(() => setSuccessMessage('Duplicate detection parameters saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save parameters');
      })
      .finally(() => setParamSaving(false));
  };

  const handleRunBackfill = () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    runGlobalDuplicatesBackfill({
      from: backfillFrom || undefined,
      to: backfillTo || undefined,
      force: backfillForce,
    })
      .then((result) => setBackfillResult(result))
      .catch((err: unknown) => {
        setBackfillError(err instanceof Error ? err.message : 'Global duplicate scan failed');
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
          <ContentCopyIcon color="primary" />
          <Typography variant="h4" component="h1">
            Near-Duplicate Detection
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Control near-duplicate photo detection globally, tune matching sensitivity, and trigger
          backfills across all circles.
        </Typography>

        {/* Model status */}
        {modelStatusError && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {modelStatusError}
          </Alert>
        )}
        {modelStatus && (
          <Alert severity={modelStatus.degraded ? 'warning' : 'success'} sx={{ mb: 2 }}>
            {modelStatus.degraded
              ? `Visual embedding model unavailable — running in degraded (hash-only) mode. Model path: ${modelStatus.modelPath}`
              : `Visual embedding model "${modelStatus.model}" is loaded and available. Model path: ${modelStatus.modelPath}`}
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
                checked={settings?.features?.duplicateDetection ?? false}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable near-duplicate detection globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            Detects visually-identical re-uploads (e.g. WhatsApp re-shares) using a CLIP visual
            embedding plus perceptual hash. Nothing is archived or deleted automatically — matches
            are surfaced in a review queue.
          </Typography>
        </Paper>

        {/* Section 2: Matching Parameters */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Matching Parameters
          </Typography>

          <Stack spacing={4} sx={{ mb: 2 }}>
            <Box>
              <Typography gutterBottom>
                Similarity threshold: <strong>{similarityThreshold.toFixed(3)}</strong>
              </Typography>
              <Slider
                value={similarityThreshold}
                onChange={(_, value) => setSimilarityThreshold(value as number)}
                min={0.8}
                max={0.995}
                step={0.005}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Minimum CLIP cosine similarity (0.80–0.995) for two photos to be linked as duplicates.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Hash max distance: <strong>{hashMaxDistance}</strong>
              </Typography>
              <Slider
                value={hashMaxDistance}
                onChange={(_, value) => setHashMaxDistance(value as number)}
                min={0}
                max={16}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Maximum dHash Hamming distance (0–16 bits, out of 64) for two photos to be linked.
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                KNN candidates: <strong>{knnCandidates}</strong>
              </Typography>
              <Slider
                value={knnCandidates}
                onChange={(_, value) => setKnnCandidates(value as number)}
                min={5}
                max={50}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Number of nearest-neighbor candidates fetched per item from the pgvector index (5–50).
              </Typography>
            </Box>

            <Box>
              <Typography gutterBottom>
                Auto-resolve threshold: <strong>{autoResolveThreshold}</strong>
              </Typography>
              <Slider
                value={autoResolveThreshold}
                onChange={(_, value) => setAutoResolveThreshold(value as number)}
                min={0}
                max={100}
                step={1}
                valueLabelDisplay="auto"
              />
              <Typography variant="caption" color="text.secondary">
                Score 0–100 (default 60). Drives the "Archive/Delete above N" buttons on the
                Duplicates review page — pending groups at or above this match score keep only the
                suggested best photo.
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
            Scan All Circles for Duplicates
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue near-duplicate detection across every circle. Jobs are chunked (100 photos per
            job) to stay well under the enrichment worker's stuck-job reset threshold.
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
            label="Force (re-embed already-processed photos)"
            sx={{ mb: 2, display: 'block' }}
          />

          {backfillResult && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {backfillResult.enqueued} job{backfillResult.enqueued !== 1 ? 's' : ''} queued covering
              ~{backfillResult.estimatedItems} photo{backfillResult.estimatedItems !== 1 ? 's' : ''} across{' '}
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
            disabled={!(settings?.features?.duplicateDetection) || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Run Global Duplicate Scan
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

export default function DuplicatesSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <DuplicatesSettingsContent />;
}
