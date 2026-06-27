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
import { CheckCircle as CheckCircleIcon, Error as ErrorIcon, Info as InfoIcon, Warning as WarningIcon } from '@mui/icons-material';
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
    saveTaggingFeature,
    saveEmbeddingFeature,
    getEmbeddingModels,
    testEmbedding,
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

  // Tagging feature state
  const [taggingProvider, setTaggingProvider] = useState('');
  const [taggingModel, setTaggingModel] = useState('');
  const [taggingModels, setTaggingModels] = useState<string[]>([]);
  const [taggingModelsLoading, setTaggingModelsLoading] = useState(false);
  const [taggingTestResult, setTaggingTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [taggingTestLoading, setTaggingTestLoading] = useState(false);

  // Embedding feature state
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false);
  const [embeddingProvider] = useState('openai'); // OpenAI is the only supported embedding provider
  const [embeddingModel, setEmbeddingModel] = useState('text-embedding-3-small');
  const [embeddingModels, setEmbeddingModels] = useState<string[]>([]);
  const [embeddingModelsLoading, setEmbeddingModelsLoading] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<{
    ok: boolean;
    dimensions?: number;
    warning?: string;
    error?: string;
  } | null>(null);
  const [embeddingTestLoading, setEmbeddingTestLoading] = useState(false);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // Sync enabled toggles from settings
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

    // Pre-populate base URL if present
    const baseUrlMap: Record<string, string> = {};
    allProviders.forEach((p) => {
      if (p.baseUrl) baseUrlMap[p.provider] = p.baseUrl;
    });
    setProviderBaseUrls(baseUrlMap);

    // Pre-populate search feature selections (guard against null provider/model)
    if (settings.features.search) {
      setSearchProvider(settings.features.search.provider ?? '');
      setSearchModel(settings.features.search.model ?? '');
    }

    // Pre-populate tagging feature selections
    if (settings.features.tagging) {
      setTaggingProvider(settings.features.tagging.provider ?? '');
      setTaggingModel(settings.features.tagging.model ?? '');
    }

    // Pre-populate embedding feature selections
    if (settings.features.embedding && settings.features.embedding.provider) {
      setEmbeddingEnabled(true);
      setEmbeddingModel(settings.features.embedding.model ?? 'text-embedding-3-small');
    } else {
      setEmbeddingEnabled(false);
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

  // Load models when tagging provider changes
  useEffect(() => {
    if (!taggingProvider) return;
    setTaggingModelsLoading(true);
    setTaggingModels([]);
    getModels(taggingProvider)
      .then((models) => setTaggingModels(models))
      .catch(() => setTaggingModels([]))
      .finally(() => setTaggingModelsLoading(false));
  }, [taggingProvider, getModels]);

  // Load embedding models on mount (OpenAI only, capability=embedding)
  useEffect(() => {
    setEmbeddingModelsLoading(true);
    getEmbeddingModels(embeddingProvider)
      .then((models) => setEmbeddingModels(models))
      .catch(() => setEmbeddingModels([]))
      .finally(() => setEmbeddingModelsLoading(false));
  }, [embeddingProvider, getEmbeddingModels]);

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

  const handleSaveTaggingFeature = async () => {
    if (!taggingProvider || !taggingModel) return;
    try {
      await saveTaggingFeature(taggingProvider, taggingModel);
      setSuccessMessage('Tagging feature settings saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save tagging feature');
    }
  };

  const handleTestTaggingProvider = async () => {
    if (!taggingProvider || !taggingModel) return;
    setTaggingTestLoading(true);
    setTaggingTestResult(null);
    try {
      const result = await testProvider(taggingProvider, taggingModel);
      setTaggingTestResult(result);
    } catch (err) {
      setTaggingTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTaggingTestLoading(false);
    }
  };

  const handleSaveEmbeddingFeature = async () => {
    try {
      if (embeddingEnabled) {
        await saveEmbeddingFeature(embeddingProvider, embeddingModel);
        setSuccessMessage('AI description embedding settings saved');
      } else {
        await saveEmbeddingFeature(null, null);
        setSuccessMessage('AI description embedding disabled');
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save embedding feature');
    }
  };

  const handleTestEmbedding = async () => {
    setEmbeddingTestLoading(true);
    setEmbeddingTestResult(null);
    try {
      const result = await testEmbedding(embeddingProvider, embeddingModel);
      setEmbeddingTestResult(result);
    } catch (err) {
      setEmbeddingTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setEmbeddingTestLoading(false);
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

        <Typography variant="h4" component="h1" gutterBottom>
          AI Settings
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure AI provider credentials and feature settings
        </Typography>

        {/* Provider sections — show configured providers AND known-but-unconfigured providers */}
        {[...(settings?.providers ?? []), ...(settings?.knownProviders ?? [])].map((providerConfig) => (
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

        {/* Tagging feature section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Tagging Feature
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 2 }}>
            <InputLabel>Provider</InputLabel>
            <Select
              label="Provider"
              value={taggingProvider}
              onChange={(e) => {
                setTaggingProvider(e.target.value);
                setTaggingModel('');
                setTaggingTestResult(null);
              }}
            >
              <MenuItem value="">Select provider</MenuItem>
              <MenuItem value="openai">OpenAI</MenuItem>
              <MenuItem value="anthropic">Anthropic</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth sx={{ mb: 2 }} disabled={!taggingProvider || taggingModelsLoading}>
            <InputLabel>Model</InputLabel>
            <Select
              label="Model"
              value={taggingModel}
              onChange={(e) => {
                setTaggingModel(e.target.value);
                setTaggingTestResult(null);
              }}
            >
              {taggingModelsLoading ? (
                <MenuItem disabled>Loading models…</MenuItem>
              ) : taggingModels.length === 0 ? (
                <MenuItem disabled>No models available</MenuItem>
              ) : (
                taggingModels.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          {/* Test result */}
          {taggingTestResult !== null && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              {taggingTestResult.ok ? (
                <CheckCircleIcon color="success" />
              ) : (
                <ErrorIcon color="error" />
              )}
              <Typography
                variant="body2"
                color={taggingTestResult.ok ? 'success.main' : 'error.main'}
              >
                {taggingTestResult.ok ? 'Connection successful' : (taggingTestResult.error ?? 'Test failed')}
              </Typography>
            </Box>
          )}

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              disabled={!taggingProvider || !taggingModel}
              onClick={() => void handleSaveTaggingFeature()}
            >
              Save
            </Button>
            <Button
              variant="outlined"
              disabled={!taggingProvider || !taggingModel || taggingTestLoading}
              startIcon={taggingTestLoading ? <CircularProgress size={16} /> : undefined}
              onClick={() => void handleTestTaggingProvider()}
            >
              Test
            </Button>
          </Stack>
        </Paper>

        {/* AI Description Search (embedding) section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            AI Description Search
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            When enabled, AI-generated descriptions are indexed as text embeddings,
            making your photos semantically searchable by meaning and scene content.
          </Typography>

          <Alert severity="info" icon={<InfoIcon fontSize="inherit" />} sx={{ mb: 1.5 }}>
            Descriptions are generated during the auto-tagging process — not here.
            The <strong>Tagging Feature</strong> (above) must be configured and auto-tagging must
            be enabled for at least one circle before any descriptions exist to search.
            This setting only controls whether those already-generated descriptions become
            semantically searchable via embeddings.
          </Alert>

          <Alert severity="info" icon={<InfoIcon fontSize="inherit" />} sx={{ mb: 2 }}>
            Requires OpenAI — text embeddings are only available through the OpenAI API.
            Make sure your OpenAI credentials are configured above before enabling this feature.
          </Alert>

          <FormControlLabel
            control={
              <Switch
                checked={embeddingEnabled}
                onChange={(e) => {
                  setEmbeddingEnabled(e.target.checked);
                  setEmbeddingTestResult(null);
                }}
              />
            }
            label="Enable AI description search"
            sx={{ mb: 2, display: 'block' }}
          />

          {embeddingEnabled && (
            <>
              {/* Provider is fixed to OpenAI */}
              <TextField
                label="Provider"
                value="OpenAI"
                size="small"
                fullWidth
                disabled
                sx={{ mb: 2 }}
              />

              <FormControl size="small" fullWidth sx={{ mb: 2 }} disabled={embeddingModelsLoading}>
                <InputLabel>Embedding Model</InputLabel>
                <Select
                  label="Embedding Model"
                  value={embeddingModel}
                  onChange={(e) => {
                    setEmbeddingModel(e.target.value);
                    setEmbeddingTestResult(null);
                  }}
                >
                  {embeddingModelsLoading ? (
                    <MenuItem disabled>Loading models…</MenuItem>
                  ) : embeddingModels.length === 0 ? (
                    <>
                      <MenuItem value="text-embedding-3-small">text-embedding-3-small (recommended)</MenuItem>
                      <MenuItem value="text-embedding-3-large">text-embedding-3-large</MenuItem>
                    </>
                  ) : (
                    embeddingModels.map((m) => (
                      <MenuItem key={m} value={m}>
                        {m === 'text-embedding-3-small' ? `${m} (recommended)` : m}
                      </MenuItem>
                    ))
                  )}
                </Select>
              </FormControl>

              {/* Embedding test result */}
              {embeddingTestResult !== null && (
                <Box sx={{ mb: 2 }}>
                  {embeddingTestResult.ok && embeddingTestResult.warning ? (
                    <Alert severity="warning" icon={<WarningIcon fontSize="inherit" />}>
                      {embeddingTestResult.warning}
                    </Alert>
                  ) : embeddingTestResult.ok ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <CheckCircleIcon color="success" />
                      <Typography variant="body2" color="success.main">
                        Connection successful — {embeddingTestResult.dimensions}-dimensional embeddings
                      </Typography>
                    </Box>
                  ) : (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <ErrorIcon color="error" />
                      <Typography variant="body2" color="error.main">
                        {embeddingTestResult.error ?? 'Test failed'}
                      </Typography>
                    </Box>
                  )}
                </Box>
              )}
            </>
          )}

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              onClick={() => void handleSaveEmbeddingFeature()}
            >
              Save
            </Button>
            {embeddingEnabled && (
              <Button
                variant="outlined"
                disabled={embeddingTestLoading}
                startIcon={embeddingTestLoading ? <CircularProgress size={16} /> : undefined}
                onClick={() => void handleTestEmbedding()}
              >
                Test
              </Button>
            )}
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
