import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
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
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Face as FaceIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useFaceSettings } from '../../hooks/useFaceSettings';
import { useCircles } from '../../hooks/useCircles';
import { runFaceBackfill } from '../../services/face';

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

  const { circles, fetchCircles } = useCircles();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Backfill state
  const [backfillCircleId, setBackfillCircleId] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);

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

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    void fetchCircles();
  }, [fetchCircles]);

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

  const handleRunBackfill = async () => {
    if (!backfillCircleId) return;
    if (
      !window.confirm(
        `Queue face detection for all unprocessed photos in the selected circle${backfillForce ? ' (force reprocess all)' : ''}? This may take a while.`,
      )
    )
      return;
    setBackfillLoading(true);
    try {
      const result = await runFaceBackfill(backfillCircleId, backfillForce || undefined);
      setSuccessMessage(`Backfill queued: ${result.queued} item(s) scheduled`);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to queue backfill');
    } finally {
      setBackfillLoading(false);
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <FaceIcon color="primary" />
          <Typography variant="h4" component="h1">
            Face Settings
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure face detection provider credentials and detection settings
        </Typography>

        {/* Provider sections */}
        {[...(settings?.providers ?? []), ...(settings?.knownProviders ?? [])].map((providerConfig) => (
          <Paper key={providerConfig.provider} variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
              <Typography variant="h6">
                {providerConfig.provider === 'compreface'
                  ? 'CompreFace'
                  : providerConfig.provider === 'rekognition'
                  ? 'AWS Rekognition'
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
              <MenuItem value="compreface">CompreFace</MenuItem>
              <MenuItem value="rekognition">AWS Rekognition</MenuItem>
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

        {/* Backfill section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Run Backfill
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue face detection for existing photos that have not yet been processed (or all photos
            if Force is enabled). Admin only.
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 2 }}>
            <InputLabel>Circle</InputLabel>
            <Select
              label="Circle"
              value={backfillCircleId}
              onChange={(e) => setBackfillCircleId(e.target.value)}
            >
              <MenuItem value="">Select circle</MenuItem>
              {circles.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControlLabel
            control={
              <Switch
                checked={backfillForce}
                onChange={(e) => setBackfillForce(e.target.checked)}
              />
            }
            label="Force (reprocess already-processed photos)"
            sx={{ mb: 2, display: 'block' }}
          />

          <Button
            variant="contained"
            disabled={!backfillCircleId || backfillLoading}
            startIcon={backfillLoading ? <CircularProgress size={16} /> : undefined}
            onClick={() => void handleRunBackfill()}
          >
            Run Backfill
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
