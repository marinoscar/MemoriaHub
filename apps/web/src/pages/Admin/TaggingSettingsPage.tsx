import { useState } from 'react';
import { Navigate } from 'react-router-dom';
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
  AlertTitle,
  Snackbar,
  Divider,
  Slider,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalTaggingBackfill } from '../../services/adminBackfill';
import type { GlobalBackfillResult } from '../../services/adminBackfill';
import { TagsContent } from './TagsPage';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';

function TaggingSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();

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

  const handleGlobalToggle = (checked: boolean) => {
    void updateSettings({ features: { ...(settings?.features ?? {}), autoTagging: checked } }).catch(
      (err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      },
    );
  };

  const videoSettings = settings?.autoTagging?.video;
  const videoEnabled = videoSettings?.enabled ?? false;
  const maxFrames = videoSettings?.maxFrames ?? 6;
  const sampleIntervalSeconds = videoSettings?.sampleIntervalSeconds ?? 5;
  const transcriptionEnabled = videoSettings?.transcription?.enabled ?? false;
  const leadSeconds = videoSettings?.transcription?.leadSeconds ?? 30;
  const transcriptionModelConfigured = !!settings?.ai?.features?.transcription;

  /**
   * PATCH only the `autoTagging.video` keys being changed. The server merges
   * this namespace field-by-field, so an unlisted key keeps its stored value.
   */
  const patchVideo = (
    patch: Partial<NonNullable<NonNullable<typeof settings>['autoTagging']>['video']>,
  ) => {
    void updateSettings({ autoTagging: { video: patch } }).catch((err: unknown) => {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    });
  };

  const handleRunBackfill = () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    setBackfillError(null);
    runGlobalTaggingBackfill({
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

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          icon={<LocalOfferIcon color="primary" />}
          title={<>AI Tagging &amp; Descriptions</>}
          description={
            <>
              Manage global auto-tagging settings, run backfills across all circles, and maintain the tag
              vocabulary.
            </>
          }
        />

        {/* Section 1: Global Settings */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={settings?.features?.autoTagging ?? false}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable AI auto-tagging &amp; descriptions globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            When enabled, new uploads are automatically tagged across all circles that have opted in.
            Disabling stops new jobs but does not affect already-processed items.
          </Typography>
        </Paper>

        {/* Section 2: Video */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Video
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Tag and describe videos as well as photos. A video costs{' '}
            <strong>one AI call carrying {maxFrames} still frames</strong>, sampled evenly across its
            whole runtime — so a three-hour recital and a thirty-second clip cost exactly the same.
            Nothing here scales with video length.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={videoEnabled}
                onChange={(e) => patchVideo({ enabled: e.target.checked })}
                disabled={isSaving || !settings || !(settings?.features?.autoTagging)}
              />
            }
            label="Enable AI tagging for videos"
            sx={{ display: 'block' }}
          />
          {!settings?.features?.autoTagging && (
            <Typography variant="caption" color="text.secondary">
              Turn on global auto-tagging above first — it is the master switch for both photos and
              videos.
            </Typography>
          )}

          <Box sx={{ mt: 3, maxWidth: 420, opacity: videoEnabled ? 1 : 0.5 }}>
            <Typography variant="body2" gutterBottom>
              Frames per video: <strong>{maxFrames}</strong>
            </Typography>
            <Slider
              value={maxFrames}
              min={1}
              max={20}
              step={1}
              marks
              valueLabelDisplay="auto"
              disabled={!videoEnabled || isSaving}
              onChangeCommitted={(_e, value) => patchVideo({ maxFrames: value as number })}
            />
            <Typography variant="caption" color="text.secondary">
              The main cost lever — every frame is a billed image on the single AI call.
            </Typography>
          </Box>

          <Box sx={{ mt: 3, maxWidth: 420, opacity: videoEnabled ? 1 : 0.5 }}>
            <Typography variant="body2" gutterBottom>
              Minimum gap between frames: <strong>{sampleIntervalSeconds}s</strong>
            </Typography>
            <Slider
              value={sampleIntervalSeconds}
              min={1}
              max={60}
              step={1}
              valueLabelDisplay="auto"
              disabled={!videoEnabled || isSaving}
              onChangeCommitted={(_e, value) =>
                patchVideo({ sampleIntervalSeconds: value as number })
              }
            />
            <Typography variant="caption" color="text.secondary">
              Short clips take fewer than the maximum number of frames; longer videos always spread
              the full budget across their runtime.
            </Typography>
          </Box>

          <Divider sx={{ my: 3 }} />

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Audio transcription
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Transcribe the <strong>first {leadSeconds} seconds</strong> of a video&apos;s audio and
            feed it to the description and to search. That is the entire audio bill per video,
            regardless of runtime. Recognized speech is stored, is deleted with the video, and never
            leaves your configured AI provider.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={transcriptionEnabled}
                onChange={(e) => patchVideo({ transcription: { enabled: e.target.checked } })}
                disabled={!videoEnabled || isSaving}
              />
            }
            label="Transcribe the opening seconds of each video"
            sx={{ display: 'block' }}
          />

          {transcriptionEnabled && !transcriptionModelConfigured && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <AlertTitle>No transcription model selected</AlertTitle>
              Videos will be tagged from their frames only until a transcription provider and model
              are configured in{' '}
              <RouterLink to="/admin/settings/ai">Admin Settings &rarr; AI</RouterLink>.
            </Alert>
          )}

          <Box sx={{ mt: 3, maxWidth: 420, opacity: videoEnabled && transcriptionEnabled ? 1 : 0.5 }}>
            <Typography variant="body2" gutterBottom>
              Seconds of audio transcribed: <strong>{leadSeconds}s</strong>
            </Typography>
            <Slider
              value={leadSeconds}
              min={5}
              max={600}
              step={5}
              valueLabelDisplay="auto"
              disabled={!videoEnabled || !transcriptionEnabled || isSaving}
              onChangeCommitted={(_e, value) =>
                patchVideo({ transcription: { leadSeconds: value as number } })
              }
            />
          </Box>
        </Paper>

        {/* Section 3: Global Backfill */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Run Backfill on All Circles
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue AI tagging for unprocessed (or all, if forced) photos across every circle that has
            auto-tagging enabled.
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
            label="Force re-tag all"
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
            disabled={!(settings?.features?.autoTagging) || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={handleRunBackfill}
          >
            Run Global Backfill
          </Button>
        </Paper>

        {/* Section 4: Tag Vocabulary */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Tag Vocabulary
          </Typography>
          <TagsContent />
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

export default function TaggingSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <TaggingSettingsContent />;
}
