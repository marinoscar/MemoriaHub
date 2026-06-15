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
import { CheckCircle as CheckCircleIcon, Error as ErrorIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiSettings } from '../../hooks/useAiSettings';

function AiSettingsContent() {
  const {
    settings,
    loading,
    error,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    getModels,
    saveSearchFeature,
  } = useAiSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Per-provider form state
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [providerBaseUrls, setProviderBaseUrls] = useState<Record<string, string>>({});
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({});

  // Search feature state
  const [searchProvider, setSearchProvider] = useState('');
  const [searchModel, setSearchModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Test result state
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // Sync enabled toggles from settings
  useEffect(() => {
    if (!settings) return;
    const enabledMap: Record<string, boolean> = {};
    settings.providers.forEach((p) => {
      enabledMap[p.provider] = p.enabled;
    });
    setProviderEnabled(enabledMap);

    // Pre-populate base URL if present
    const baseUrlMap: Record<string, string> = {};
    settings.providers.forEach((p) => {
      if (p.baseUrl) baseUrlMap[p.provider] = p.baseUrl;
    });
    setProviderBaseUrls(baseUrlMap);

    // Pre-populate search feature selections
    if (settings.features.search) {
      setSearchProvider(settings.features.search.provider);
      setSearchModel(settings.features.search.model);
    }
  }, [settings]);

  // Load models when search provider changes
  useEffect(() => {
    if (!searchProvider) return;
    setModelsLoading(true);
    setAvailableModels([]);
    getModels(searchProvider)
      .then((models) => setAvailableModels(models))
      .catch(() => setAvailableModels([]))
      .finally(() => setModelsLoading(false));
  }, [searchProvider, getModels]);

  const handleSaveCredentials = async (provider: string) => {
    try {
      const apiKey = providerKeys[provider] ?? '';
      const baseUrl = providerBaseUrls[provider] ?? undefined;
      const enabled = providerEnabled[provider] ?? true;
      await saveCredentials(provider, {
        ...(apiKey ? { apiKey } : { apiKey: '' }),
        baseUrl: baseUrl || undefined,
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
    if (!window.confirm(`Remove credentials for ${provider}? This will disable AI features using this provider.`)) return;
    try {
      await removeCredentials(provider);
      setSuccessMessage(`${provider} credentials removed`);
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to remove credentials');
    }
  };

  const handleSaveSearchFeature = async () => {
    if (!searchProvider || !searchModel) return;
    try {
      await saveSearchFeature(searchProvider, searchModel);
      setSuccessMessage('Search feature settings saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save search feature');
    }
  };

  const handleTestProvider = async () => {
    if (!searchProvider || !searchModel) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await testProvider(searchProvider, searchModel);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestLoading(false);
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
        <Typography variant="h4" component="h1" gutterBottom>
          AI Settings
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure AI provider credentials and feature settings
        </Typography>

        {/* Provider sections */}
        {(settings?.providers ?? []).map((providerConfig) => (
          <Paper key={providerConfig.provider} variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <Typography variant="h6">
                {providerConfig.provider.toUpperCase()}
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

            {/* Base URL (OpenAI only) */}
            {providerConfig.provider === 'openai' && (
              <TextField
                label="Base URL (optional)"
                size="small"
                fullWidth
                value={providerBaseUrls[providerConfig.provider] ?? ''}
                onChange={(e) =>
                  setProviderBaseUrls((prev) => ({
                    ...prev,
                    [providerConfig.provider]: e.target.value,
                  }))
                }
                placeholder="https://api.openai.com"
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

        {/* Search feature section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Search Feature
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 2 }}>
            <InputLabel>Provider</InputLabel>
            <Select
              label="Provider"
              value={searchProvider}
              onChange={(e) => {
                setSearchProvider(e.target.value);
                setSearchModel('');
                setTestResult(null);
              }}
            >
              <MenuItem value="">Select provider</MenuItem>
              <MenuItem value="openai">OpenAI</MenuItem>
              <MenuItem value="anthropic">Anthropic</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth sx={{ mb: 2 }} disabled={!searchProvider || modelsLoading}>
            <InputLabel>Model</InputLabel>
            <Select
              label="Model"
              value={searchModel}
              onChange={(e) => {
                setSearchModel(e.target.value);
                setTestResult(null);
              }}
            >
              {modelsLoading ? (
                <MenuItem disabled>Loading models…</MenuItem>
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
              disabled={!searchProvider || !searchModel}
              onClick={() => void handleSaveSearchFeature()}
            >
              Save
            </Button>
            <Button
              variant="outlined"
              disabled={!searchProvider || !searchModel || testLoading}
              startIcon={testLoading ? <CircularProgress size={16} /> : undefined}
              onClick={() => void handleTestProvider()}
            >
              Test
            </Button>
          </Stack>
        </Paper>

        {/* Archive / retention info */}
        {settings?.conversations && (
          <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Conversation Retention
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Archive after:{' '}
              <strong>{settings.conversations.archiveAfterDays} days</strong>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Delete after archiving:{' '}
              <strong>{settings.conversations.deleteAfterArchiveDays} days</strong>
            </Typography>
          </Paper>
        )}
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

export default function AiSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <AiSettingsContent />;
}
