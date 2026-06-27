import { useEffect, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Chip,
  TextField,
  FormControlLabel,
  Switch,
  Stack,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Snackbar,
  Link,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Face as FaceIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useFaceSettings } from '../../hooks/useFaceSettings';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalFaceBackfill } from '../../services/adminBackfill';

function FaceSettingsContent() {
  const {
    settings,
    loading,
    error,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    getModels,
    saveDetectionFeature,
  } = useFaceSettings();

  const { settings: sysSettings, isSaving: sysSaving, updateSettings: updateSysSettings } = useSystemSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Global backfill state
  const [globalBackfillFrom, setGlobalBackfillFrom] = useState('');
  const [globalBackfillTo, setGlobalBackfillTo] = useState('');
  const [globalBackfillForce, setGlobalBackfillForce] = useState(false);
  const [globalBackfillLoading, setGlobalBackfillLoading] = useState(false);

  // Per-provider form state
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [providerBaseUrls, setProviderBaseUrls] = useState<Record<string, string>>({});
  const [providerRegions, setProviderRegions] = useState<Record<string, string>>({});
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({});

  // Detection feature state
  const [detectionProvider, setDetectionProvider] = useState('');
  const [detectionModel, setDetectionModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Test result state
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Per-provider card test state
  const [perProviderTestResult, setPerProviderTestResult] = useState<Record<string, { ok: boolean; error?: string } | null>>({});
  const [perProviderTestLoading, setPerProviderTestLoading] = useState<Record<string, boolean>>({});

  // Video face detection settings
  const [videoEnabled, setVideoEnabled] = useState<boolean>(false);
  const [videoSampleInterval, setVideoSampleInterval] = useState<number>(5);
  const [videoMaxFrames, setVideoMaxFrames] = useState<number>(60);
  const [videoSettingsSaving, setVideoSettingsSaving] = useState(false);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // Sync enabled toggles and URLs from settings
  useEffect(() => {
    if (!settings) return;
    const allProviders = [
      ...(settings.providers ?? []),
      ...(settings.knownProviders ?? []),
    ];

    const enabledMap: Record<string, boolean> = {};
    allProviders.forEach((p) => {
      enabledMap[p.provider] = p.enabled;
    });
    setProviderEnabled(enabledMap);

    const baseUrlMap: Record<string, string> = {};
    allProviders.forEach((p) => {
      if (p.baseUrl) baseUrlMap[p.provider] = p.baseUrl;
    });
    setProviderBaseUrls(baseUrlMap);

    const regionMap: Record<string, string> = {};
    allProviders.forEach((p) => {
      if (p.region) regionMap[p.provider] = p.region;
    });
    setProviderRegions(regionMap);

    // Pre-populate detection feature selections
    if (settings.features.detection) {
      setDetectionProvider(settings.features.detection.provider ?? '');
      setDetectionModel(settings.features.detection.model ?? '');
    }
  }, [settings]);

  // Sync video face detection settings from sysSettings
  useEffect(() => {
    if (!sysSettings) return;
    const v = sysSettings.face?.video;
    setVideoEnabled(v?.enabled ?? false);
    setVideoSampleInterval(v?.sampleIntervalSeconds ?? 5);
    setVideoMaxFrames(v?.maxFramesPerVideo ?? 60);
  }, [sysSettings]);

  // Load models when detection provider changes
  useEffect(() => {
    if (!detectionProvider) return;
    setModelsLoading(true);
    setAvailableModels([]);
    getModels(detectionProvider)
      .then((models) => setAvailableModels(models))
      .catch(() => setAvailableModels([]))
      .finally(() => setModelsLoading(false));
  }, [detectionProvider, getModels]);

  const handleSaveCredentials = async (provider: string) => {
    try {
      const apiKey = providerKeys[provider] ?? undefined;
      const baseUrl = providerBaseUrls[provider] ?? undefined;
      const region = providerRegions[provider] ?? undefined;
      const enabled = providerEnabled[provider] ?? true;
      await saveCredentials(provider, {
        ...(apiKey ? { apiKey } : {}),
        baseUrl: baseUrl || undefined,
        region: region || undefined,
        enabled,
      });
      setSuccessMessage(`${provider} credentials saved`);
      setProviderKeys((prev) => ({ ...prev, [provider]: '' }));
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save credentials');
    }
  };

  const handleRemoveCredentials = async (provider: string) => {
    if (!window.confirm(`Remove credentials for ${provider}? This will disable face detection using this provider.`)) return;
    try {
      await removeCredentials(provider);
      setSuccessMessage(`${provider} credentials removed`);
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to remove credentials');
    }
  };

  const handleTestProviderCard = async (provider: string) => {
    setPerProviderTestLoading((prev) => ({ ...prev, [provider]: true }));
    setPerProviderTestResult((prev) => ({ ...prev, [provider]: null }));
    try {
      const result = await testProvider(provider);
      setPerProviderTestResult((prev) => ({ ...prev, [provider]: result }));
    } catch (err) {
      setPerProviderTestResult((prev) => ({
        ...prev,
        [provider]: { ok: false, error: err instanceof Error ? err.message : 'Test failed' },
      }));
    } finally {
      setPerProviderTestLoading((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const handleSaveDetectionFeature = async () => {
    if (!detectionProvider || !detectionModel) return;
    try {
      await saveDetectionFeature(detectionProvider, detectionModel);
      setSuccessMessage('Detection feature settings saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save detection feature');
    }
  };

  const handleTestProvider = async () => {
    if (!detectionProvider || !detectionModel) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await testProvider(detectionProvider, detectionModel);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestLoading(false);
    }
  };

  const handleSaveVideoSettings = async () => {
    setVideoSettingsSaving(true);
    try {
      await updateSysSettings({
        face: {
          video: {
            enabled: videoEnabled,
            sampleIntervalSeconds: videoSampleInterval,
            maxFramesPerVideo: videoMaxFrames,
          },
        },
      });
      setSuccessMessage('Video face detection settings saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save video settings');
    } finally {
      setVideoSettingsSaving(false);
    }
  };

  if (loading && !settings) {
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

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <FaceIcon color="primary" />
          <Typography variant="h4" component="h1">
            Face Settings
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure face detection provider credentials and detection settings
        </Typography>

        {/* Global face recognition section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Face Recognition (Global)
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Master switch for face recognition across all circles. Per-circle opt-in still applies.
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={sysSettings?.features?.faceRecognition ?? false}
                onChange={(e) => {
                  void updateSysSettings({
                    features: { ...(sysSettings?.features ?? {}), faceRecognition: e.target.checked },
                  });
                }}
                disabled={sysSaving || !sysSettings}
              />
            }
            label="Enable face recognition globally"
            sx={{ mb: 2, display: 'block' }}
          />

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Run Global Face Backfill
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue face detection for existing photos across all circles that have face recognition
            enabled.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 1 }}>
            <TextField
              label="From date"
              type="date"
              size="small"
              value={globalBackfillFrom}
              onChange={(e) => setGlobalBackfillFrom(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="To date"
              type="date"
              size="small"
              value={globalBackfillTo}
              onChange={(e) => setGlobalBackfillTo(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            Optionally limit by capture date. Leave blank to process all photos.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={globalBackfillForce}
                onChange={(e) => setGlobalBackfillForce(e.target.checked)}
              />
            }
            label="Force (reprocess already-processed photos)"
            sx={{ mb: 2, display: 'block' }}
          />
          <Button
            variant="contained"
            disabled={globalBackfillLoading || !(sysSettings?.features?.faceRecognition)}
            startIcon={globalBackfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={() => {
              setGlobalBackfillLoading(true);
              runGlobalFaceBackfill({
                from: globalBackfillFrom || undefined,
                to: globalBackfillTo || undefined,
                force: globalBackfillForce || undefined,
              })
                .then((result) =>
                  setSuccessMessage(
                    `${result.enqueued} jobs queued across ${result.circles} circle(s).`,
                  ),
                )
                .catch((err: unknown) =>
                  setLocalError(err instanceof Error ? err.message : 'Global backfill failed'),
                )
                .finally(() => setGlobalBackfillLoading(false));
            }}
          >
            Run Global Backfill
          </Button>
        </Paper>

        {/* Provider sections */}
        {[...(settings?.providers ?? []), ...(settings?.knownProviders ?? [])].map((providerConfig) => (
          <Paper key={providerConfig.provider} variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
              <Typography variant="h6">
                {providerConfig.provider === 'compreface'
                  ? 'CompreFace'
                  : providerConfig.provider === 'rekognition'
                  ? 'AWS Rekognition'
                  : providerConfig.provider === 'human'
                  ? 'Human (in-process)'
                  : providerConfig.provider.toUpperCase()}
              </Typography>
              <Chip
                label={providerConfig.enabled ? 'Enabled' : 'Disabled'}
                color={providerConfig.enabled ? 'success' : 'default'}
                size="small"
                variant="outlined"
              />
              {providerConfig.configured && (
                <Chip label="Configured" color="primary" size="small" variant="outlined" />
              )}
              {/* Capability badges */}
              {providerConfig.capabilities?.detect && (
                <Chip label="Detect" size="small" color="info" variant="outlined" />
              )}
              {providerConfig.capabilities?.embed && (
                <Chip label="Embed" size="small" color="info" variant="outlined" />
              )}
              {providerConfig.capabilities?.delegatedRecognize && (
                <Chip label="Delegated Recognize" size="small" color="info" variant="outlined" />
              )}
            </Box>

            {providerConfig.requiresCredentials === false ? (
              /* Keyless provider */
              providerConfig.provider === 'compreface' ? (
                /* CompreFace: keyless but has an editable Service URL */
                <Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Runs in the compreface-core container — no API key required.
                  </Typography>
                  <TextField
                    label="Service URL"
                    size="small"
                    fullWidth
                    value={providerBaseUrls[providerConfig.provider] ?? ''}
                    onChange={(e) =>
                      setProviderBaseUrls((prev) => ({
                        ...prev,
                        [providerConfig.provider]: e.target.value,
                      }))
                    }
                    placeholder="http://compreface-core:3000"
                    helperText="Override the default service URL. Leave as-is if using the bundled container."
                    sx={{ mb: 2 }}
                  />
                  <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => void handleSaveCredentials(providerConfig.provider)}
                    >
                      Save
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => void handleRemoveCredentials(providerConfig.provider)}
                    >
                      Reset to default
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={perProviderTestLoading[providerConfig.provider]}
                      startIcon={
                        perProviderTestLoading[providerConfig.provider] ? (
                          <CircularProgress size={14} />
                        ) : undefined
                      }
                      onClick={() => void handleTestProviderCard(providerConfig.provider)}
                    >
                      Test connection
                    </Button>
                  </Stack>
                  {perProviderTestResult[providerConfig.provider] != null && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                      {perProviderTestResult[providerConfig.provider]!.ok ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <ErrorIcon color="error" fontSize="small" />
                      )}
                      <Typography
                        variant="body2"
                        color={
                          perProviderTestResult[providerConfig.provider]!.ok
                            ? 'success.main'
                            : 'error.main'
                        }
                      >
                        {perProviderTestResult[providerConfig.provider]!.ok
                          ? 'Running'
                          : (perProviderTestResult[providerConfig.provider]!.error ?? 'Test failed')}
                      </Typography>
                    </Box>
                  )}
                </Box>
              ) : (
                /* Other keyless providers (human): no config at all */
                <Box>
                  <Alert severity="info" icon={false} sx={{ py: 0.5, mb: 1 }}>
                    No configuration required — runs in-process
                  </Alert>
                  <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center' }}>
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={perProviderTestLoading[providerConfig.provider]}
                      startIcon={
                        perProviderTestLoading[providerConfig.provider] ? (
                          <CircularProgress size={14} />
                        ) : undefined
                      }
                      onClick={() => void handleTestProviderCard(providerConfig.provider)}
                    >
                      Test connection
                    </Button>
                  </Stack>
                  {perProviderTestResult[providerConfig.provider] != null && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                      {perProviderTestResult[providerConfig.provider]!.ok ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <ErrorIcon color="error" fontSize="small" />
                      )}
                      <Typography
                        variant="body2"
                        color={
                          perProviderTestResult[providerConfig.provider]!.ok
                            ? 'success.main'
                            : 'error.main'
                        }
                      >
                        {perProviderTestResult[providerConfig.provider]!.ok
                          ? 'Running'
                          : (perProviderTestResult[providerConfig.provider]!.error ?? 'Test failed')}
                      </Typography>
                    </Box>
                  )}
                </Box>
              )
            ) : (
              <>
                {/* Current key (masked) */}
                {providerConfig.configured && providerConfig.last4 && (
                  <TextField
                    label="Current API Key"
                    value={`••••••••${providerConfig.last4}`}
                    size="small"
                    fullWidth
                    disabled
                    sx={{ mb: 2 }}
                  />
                )}

                {/* New API key input */}
                <TextField
                  label="New API Key"
                  type="password"
                  size="small"
                  fullWidth
                  value={providerKeys[providerConfig.provider] ?? ''}
                  onChange={(e) =>
                    setProviderKeys((prev) => ({
                      ...prev,
                      [providerConfig.provider]: e.target.value,
                    }))
                  }
                  placeholder={providerConfig.configured ? 'Leave blank to keep current key' : 'Enter API key'}
                  sx={{ mb: 2 }}
                />

                {/* Base URL (CompreFace only) */}
                {providerConfig.provider === 'compreface' && (
                  <TextField
                    label="Base URL"
                    size="small"
                    fullWidth
                    value={providerBaseUrls[providerConfig.provider] ?? ''}
                    onChange={(e) =>
                      setProviderBaseUrls((prev) => ({
                        ...prev,
                        [providerConfig.provider]: e.target.value,
                      }))
                    }
                    placeholder="http://compreface:8000"
                    sx={{ mb: 2 }}
                  />
                )}

                {/* Region (Rekognition only) */}
                {providerConfig.provider === 'rekognition' && (
                  <TextField
                    label="AWS Region"
                    size="small"
                    fullWidth
                    value={providerRegions[providerConfig.provider] ?? ''}
                    onChange={(e) =>
                      setProviderRegions((prev) => ({
                        ...prev,
                        [providerConfig.provider]: e.target.value,
                      }))
                    }
                    placeholder="us-east-1"
                    sx={{ mb: 2 }}
                  />
                )}

                {/* Enabled toggle */}
                <FormControlLabel
                  control={
                    <Switch
                      checked={providerEnabled[providerConfig.provider] ?? providerConfig.enabled}
                      onChange={(e) =>
                        setProviderEnabled((prev) => ({
                          ...prev,
                          [providerConfig.provider]: e.target.checked,
                        }))
                      }
                    />
                  }
                  label="Enabled"
                  sx={{ mb: 2, display: 'block' }}
                />

                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    onClick={() => void handleSaveCredentials(providerConfig.provider)}
                  >
                    Save
                  </Button>
                  {providerConfig.configured && (
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={() => void handleRemoveCredentials(providerConfig.provider)}
                    >
                      Remove
                    </Button>
                  )}
                </Stack>
              </>
            )}
          </Paper>
        ))}

        {/* Detection feature section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Detection Feature
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 2 }}>
            <InputLabel>Provider</InputLabel>
            <Select
              label="Provider"
              value={detectionProvider}
              onChange={(e) => {
                setDetectionProvider(e.target.value);
                setDetectionModel('');
                setTestResult(null);
              }}
            >
              <MenuItem value="">Select provider</MenuItem>
              {[...(settings?.providers ?? []), ...(settings?.knownProviders ?? [])].map((p) => (
                <MenuItem key={p.provider} value={p.provider}>
                  {p.provider === 'compreface'
                    ? 'CompreFace'
                    : p.provider === 'rekognition'
                    ? 'AWS Rekognition'
                    : p.provider === 'human'
                    ? 'Human (in-process)'
                    : p.provider.toUpperCase()}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth sx={{ mb: 2 }} disabled={!detectionProvider || modelsLoading}>
            <InputLabel>Model</InputLabel>
            <Select
              label="Model"
              value={detectionModel}
              onChange={(e) => {
                setDetectionModel(e.target.value);
                setTestResult(null);
              }}
            >
              {modelsLoading ? (
                <MenuItem disabled>Loading models...</MenuItem>
              ) : availableModels.length === 0 ? (
                <MenuItem disabled>No models available</MenuItem>
              ) : (
                availableModels.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          {/* Test result */}
          {testResult !== null && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              {testResult.ok ? (
                <CheckCircleIcon color="success" />
              ) : (
                <ErrorIcon color="error" />
              )}
              <Typography
                variant="body2"
                color={testResult.ok ? 'success.main' : 'error.main'}
              >
                {testResult.ok ? 'Connection successful' : (testResult.error ?? 'Test failed')}
              </Typography>
            </Box>
          )}

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              disabled={!detectionProvider || !detectionModel}
              onClick={() => void handleSaveDetectionFeature()}
            >
              Save
            </Button>
            <Button
              variant="outlined"
              disabled={!detectionProvider || !detectionModel || testLoading}
              startIcon={testLoading ? <CircularProgress size={16} /> : undefined}
              onClick={() => void handleTestProvider()}
            >
              Test
            </Button>
          </Stack>
        </Paper>

        {/* Video Face Detection settings */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Video Face Detection
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Configure how face detection runs on videos. Frames are sampled at regular intervals;
            more frames increase recall but use more CPU — and, for AWS Rekognition, incur a
            per-frame API cost. Example: a 1-hour video at a cap of 60 frames = one frame sampled
            every ~60 s.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={videoEnabled}
                onChange={(e) => setVideoEnabled(e.target.checked)}
                disabled={sysSaving || videoSettingsSaving || !sysSettings}
              />
            }
            label="Enable video face detection"
            sx={{ mb: 2, display: 'block' }}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="Sample interval (seconds)"
              type="number"
              size="small"
              value={videoSampleInterval}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 60) setVideoSampleInterval(v);
              }}
              slotProps={{ htmlInput: { min: 1, max: 60 } }}
              helperText="1–60 s. Lower = more frames, better recall, more cost."
              sx={{ flex: 1 }}
              disabled={!videoEnabled || videoSettingsSaving}
            />
            <TextField
              label="Max frames per video"
              type="number"
              size="small"
              value={videoMaxFrames}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 300) setVideoMaxFrames(v);
              }}
              slotProps={{ htmlInput: { min: 1, max: 300 } }}
              helperText="1–300. Caps total frames regardless of duration."
              sx={{ flex: 1 }}
              disabled={!videoEnabled || videoSettingsSaving}
            />
          </Stack>

          <Button
            variant="contained"
            onClick={() => void handleSaveVideoSettings()}
            disabled={!sysSettings || sysSaving || videoSettingsSaving}
            startIcon={videoSettingsSaving ? <CircularProgress size={16} /> : undefined}
          >
            Save
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
      <Snackbar
        open={!!localError}
        autoHideDuration={5000}
        onClose={() => setLocalError(null)}
      >
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default function FaceSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <FaceSettingsContent />;
}
