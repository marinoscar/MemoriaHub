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
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import { Videocam as VideocamIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalSocialBackfill, getSocialDetectors } from '../../services/social';
import type { SocialDetectorsDto } from '../../services/social';

interface BackfillResult {
  enqueued: number;
  circles: number;
}

function SocialSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

  // Backfill state
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Detectors state
  const [detectors, setDetectors] = useState<SocialDetectorsDto | null>(null);
  const [detectorsLoading, setDetectorsLoading] = useState(false);
  const [detectorsError, setDetectorsError] = useState<string | null>(null);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDetectorsLoading(true);
    setDetectorsError(null);
    getSocialDetectors()
      .then((data) => setDetectors(data))
      .catch((err: unknown) => {
        setDetectorsError(err instanceof Error ? err.message : 'Failed to load detector list');
      })
      .finally(() => setDetectorsLoading(false));
  }, []);

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({
      features: { ...(settings?.features ?? {}), socialMediaDetection: checked },
    }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  const handleRunBackfill = () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    runGlobalSocialBackfill({
      from: backfillFrom || undefined,
      to: backfillTo || undefined,
      force: backfillForce,
    })
      .then((result) => setBackfillResult(result))
      .catch((err: unknown) => {
        setBackfillError(err instanceof Error ? err.message : 'Global backfill failed');
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

  // Access the toggle from system settings features object
  const socialEnabled = (settings?.features as Record<string, unknown> | undefined)?.socialMediaDetection === true;

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
          <VideocamIcon color="primary" />
          <Typography variant="h4" component="h1">
            Social Media Detection
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Detect videos downloaded from social media platforms and apply protected system tags.
        </Typography>

        {/* Section 1: Global Settings */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={socialEnabled}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable social media detection globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            When enabled, uploaded videos are scanned to detect their origin platform (TikTok, Instagram,
            Facebook, etc.) and tagged with protected system tags. Disabling stops new jobs but does not
            remove existing tags.
          </Typography>
        </Paper>

        {/* Section 2: Global Backfill */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Run Backfill on All Circles
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue social media detection for unprocessed (or all, if forced) videos across every circle.
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
            label="Force re-scan all"
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
            disabled={!socialEnabled || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Run Global Backfill
          </Button>
        </Paper>

        {/* Section 3: Detected Platforms */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Detected Platforms
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The following platforms are supported by the detection engine. Each detected platform applies a
            protected system tag to the video.
          </Typography>

          {detectorsLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {detectorsError && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Could not load detector list: {detectorsError}
            </Alert>
          )}

          {detectors && !detectorsLoading && (
            <>
              <Typography variant="body2" sx={{ mb: 1 }}>
                Main tag applied to all social media videos:{' '}
                <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                  {detectors.mainTag}
                </Box>
              </Typography>
              <List dense disablePadding>
                {detectors.platforms.map((p) => (
                  <ListItem key={p.key} disablePadding sx={{ py: 0.25 }}>
                    <ListItemText
                      primary={p.key}
                      secondary={`Tag: ${p.tagName}`}
                      primaryTypographyProps={{ variant: 'body2', fontWeight: 500 }}
                      secondaryTypographyProps={{ variant: 'caption', fontFamily: 'monospace' }}
                    />
                  </ListItem>
                ))}
              </List>
            </>
          )}
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

export default function SocialSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <SocialSettingsContent />;
}
