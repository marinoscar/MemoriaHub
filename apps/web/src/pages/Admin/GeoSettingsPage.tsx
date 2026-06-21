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
  LocationOn as LocationOnIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useGeoSettings } from '../../hooks/useGeoSettings';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGeoBackfill } from '../../services/geo';
import type { GeoReverseProvider } from '../../services/geo';

const PROVIDER_LABELS: Record<string, string> = {
  offline: 'Offline (GeoNames)',
  nominatim: 'Nominatim (OpenStreetMap)',
  google: 'Google Maps',
};

// Providers that require an API key
const REQUIRES_KEY = new Set(['google']);

function GeoSettingsContent() {
  const {
    settings,
    loading,
    error,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    saveReverseFeature,
  } = useGeoSettings();

  const {
    settings: sysSettings,
    isSaving: sysSaving,
    updateSettings: updateSysSettings,
  } = useSystemSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Active reverse provider
  const [activeReverseProvider, setActiveReverseProvider] = useState<GeoReverseProvider>('offline');
  const [savingReverseProvider, setSavingReverseProvider] = useState(false);

  // Per-provider form state
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [providerBaseUrls, setProviderBaseUrls] = useState<Record<string, string>>({});
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({});

  // Per-provider test state
  const [perProviderTestResult, setPerProviderTestResult] = useState<
    Record<string, { ok: boolean; sample?: { country?: string; locality?: string; placeName?: string }; error?: string } | null>
  >({});
  const [perProviderTestLoading, setPerProviderTestLoading] = useState<Record<string, boolean>>({});

  // Backfill state
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillForce, setBackfillForce] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (!settings) return;
    setActiveReverseProvider(settings.activeReverseProvider);

    const enabledMap: Record<string, boolean> = {};
    settings.providers.forEach((p) => {
      enabledMap[p.provider] = p.enabled;
    });
    setProviderEnabled(enabledMap);

    const baseUrlMap: Record<string, string> = {};
    settings.providers.forEach((p) => {
      if (p.baseUrl) baseUrlMap[p.provider] = p.baseUrl;
    });
    setProviderBaseUrls(baseUrlMap);
  }, [settings]);

  const handleSaveReverseProvider = async () => {
    setSavingReverseProvider(true);
    try {
      await saveReverseFeature(activeReverseProvider);
      setSuccessMessage('Active reverse geocoding provider saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save reverse provider');
    } finally {
      setSavingReverseProvider(false);
    }
  };

  const handleSaveCredentials = async (provider: string) => {
    try {
      const apiKey = providerKeys[provider] ?? '';
      const baseUrl = providerBaseUrls[provider] ?? undefined;
      const enabled = providerEnabled[provider] ?? true;
      await saveCredentials(provider, {
        apiKey,
        baseUrl: baseUrl || undefined,
        enabled,
      });
      setSuccessMessage(`${PROVIDER_LABELS[provider] ?? provider} credentials saved`);
      setProviderKeys((prev) => ({ ...prev, [provider]: '' }));
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save credentials');
    }
  };

  const handleRemoveCredentials = async (provider: string) => {
    if (!window.confirm(`Remove credentials for ${PROVIDER_LABELS[provider] ?? provider}? This will disable geocoding using this provider.`)) return;
    try {
      await removeCredentials(provider);
      setSuccessMessage(`${PROVIDER_LABELS[provider] ?? provider} credentials removed`);
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to remove credentials');
    }
  };

  const handleTestProvider = async (provider: GeoReverseProvider) => {
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

  const handleRunBackfill = async () => {
    if (
      !window.confirm(
        `Queue geocoding backfill for all photos app-wide${backfillForce ? ' (force re-geocode all)' : ''}? This may take a while.`,
      )
    )
      return;
    setBackfillLoading(true);
    try {
      const result = await runGeoBackfill({
        from: backfillFrom || undefined,
        to: backfillTo || undefined,
        force: backfillForce || undefined,
      });
      setSuccessMessage(
        `Backfill queued: ${result.enqueued} item(s) scheduled. Track progress in Admin → Jobs.`,
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to queue backfill');
    } finally {
      setBackfillLoading(false);
    }
  };

  const handleForwardSearchChange = (checked: boolean) => {
    void updateSysSettings({
      geo: {
        forwardSearchEnabled: checked,
      },
    })
      .then(() => setSuccessMessage('Forward search setting saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      });
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

  // Build the list of all providers to show (configured + known).
  // The backend returns only configured providers in `providers`. We always show at least
  // offline, nominatim, and google so the admin can configure them.
  const knownProviderKeys: GeoReverseProvider[] = ['offline', 'nominatim', 'google'];
  const configuredProviders = new Set((settings?.providers ?? []).map((p) => p.provider));
  const allProviders = [
    ...(settings?.providers ?? []),
    ...knownProviderKeys
      .filter((k) => !configuredProviders.has(k))
      .map((k) => ({
        provider: k,
        configured: false,
        enabled: false,
        last4: null,
        baseUrl: null,
      })),
  ];

  const forwardSearchEnabled = sysSettings?.geo?.forwardSearchEnabled ?? false;

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
          <LocationOnIcon color="primary" />
          <Typography variant="h4" component="h1">
            Geo Settings
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure reverse geocoding provider and credentials
        </Typography>

        {/* Active reverse provider */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Active Reverse Geocoding Provider
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Controls which provider resolves GPS coordinates to place names when photos are uploaded.
          </Typography>

          <Alert severity="info" sx={{ mb: 2 }}>
            <strong>Privacy note:</strong> Offline (GeoNames) keeps GPS coordinates on your server.
            Nominatim (OpenStreetMap) and Google Maps send GPS coordinates to external servers.
          </Alert>

          <FormControl size="small" fullWidth sx={{ mb: 2 }}>
            <InputLabel>Provider</InputLabel>
            <Select
              label="Provider"
              value={activeReverseProvider}
              onChange={(e) => setActiveReverseProvider(e.target.value as GeoReverseProvider)}
            >
              <MenuItem value="offline">Offline (GeoNames) — on-server, no API key required</MenuItem>
              <MenuItem value="nominatim">Nominatim (OpenStreetMap) — sends GPS off-server, no API key required</MenuItem>
              <MenuItem value="google">Google Maps — sends GPS off-server, requires API key</MenuItem>
            </Select>
          </FormControl>

          <Button
            variant="contained"
            disabled={savingReverseProvider}
            startIcon={savingReverseProvider ? <CircularProgress size={16} /> : undefined}
            onClick={() => void handleSaveReverseProvider()}
          >
            Save
          </Button>
        </Paper>

        {/* Provider cards */}
        {allProviders.map((providerConfig) => {
          const needsKey = REQUIRES_KEY.has(providerConfig.provider);
          const testResult = perProviderTestResult[providerConfig.provider];
          const testLoading = perProviderTestLoading[providerConfig.provider] ?? false;

          return (
            <Paper key={providerConfig.provider} variant="outlined" sx={{ p: 3, mb: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
                <Typography variant="h6">
                  {PROVIDER_LABELS[providerConfig.provider] ?? providerConfig.provider.toUpperCase()}
                </Typography>
                <Chip
                  label={providerConfig.configured ? 'Configured' : 'Not configured'}
                  color={providerConfig.configured ? 'primary' : 'default'}
                  size="small"
                  variant="outlined"
                />
                {providerConfig.configured && (
                  <Chip
                    label={providerConfig.enabled ? 'Enabled' : 'Disabled'}
                    color={providerConfig.enabled ? 'success' : 'default'}
                    size="small"
                    variant="outlined"
                  />
                )}
              </Box>

              {!needsKey ? (
                /* Keyless provider — just a Test button */
                <Box>
                  <Alert severity="info" icon={false} sx={{ py: 0.5, mb: 2 }}>
                    No API key required.{' '}
                    {providerConfig.provider === 'offline'
                      ? 'Uses the bundled GeoNames dataset on-server.'
                      : 'Uses the Nominatim OpenStreetMap API.'}
                  </Alert>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={testLoading}
                      startIcon={testLoading ? <CircularProgress size={14} /> : undefined}
                      onClick={() => void handleTestProvider(providerConfig.provider as GeoReverseProvider)}
                    >
                      Test connection
                    </Button>
                  </Stack>
                  {testResult != null && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                      {testResult.ok ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <ErrorIcon color="error" fontSize="small" />
                      )}
                      <Typography
                        variant="body2"
                        color={testResult.ok ? 'success.main' : 'error.main'}
                      >
                        {testResult.ok
                          ? testResult.sample
                            ? `OK — sample: ${[testResult.sample.placeName, testResult.sample.locality, testResult.sample.country].filter(Boolean).join(', ')}`
                            : 'Connection successful'
                          : (testResult.error ?? 'Test failed')}
                      </Typography>
                    </Box>
                  )}
                </Box>
              ) : (
                /* Keyed provider (Google Maps) */
                <>
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
                    <Button
                      variant="outlined"
                      disabled={testLoading}
                      startIcon={testLoading ? <CircularProgress size={16} /> : undefined}
                      onClick={() => void handleTestProvider(providerConfig.provider as GeoReverseProvider)}
                    >
                      Test connection
                    </Button>
                  </Stack>

                  {testResult != null && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                      {testResult.ok ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <ErrorIcon color="error" fontSize="small" />
                      )}
                      <Typography
                        variant="body2"
                        color={testResult.ok ? 'success.main' : 'error.main'}
                      >
                        {testResult.ok
                          ? testResult.sample
                            ? `OK — sample: ${[testResult.sample.placeName, testResult.sample.locality, testResult.sample.country].filter(Boolean).join(', ')}`
                            : 'Connection successful'
                          : (testResult.error ?? 'Test failed')}
                      </Typography>
                    </Box>
                  )}
                </>
              )}
            </Paper>
          );
        })}

        {/* Forward Search section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Forward Search
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={forwardSearchEnabled}
                onChange={(e) => handleForwardSearchChange(e.target.checked)}
                disabled={sysSaving || !sysSettings}
              />
            }
            label="Enable forward location search"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Allows users to search by place name (e.g. &lsquo;Paris&rsquo;). Uses Nominatim &mdash;
            only enable if your privacy policy allows off-server requests.
          </Typography>

          {forwardSearchEnabled && (
            <Alert severity="warning">
              Forward search sends typed location queries to nominatim.openstreetmap.org.
            </Alert>
          )}
        </Paper>

        {/* Backfill section */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            App-wide Geocoding Backfill
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Queue reverse geocoding for photos that have GPS coordinates but no resolved location
            yet. By default, only unresolved photos are processed. Enable Force to re-geocode all
            photos. Progress is visible in the Admin → Jobs dashboard.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="From (capture date)"
              type="date"
              size="small"
              slotProps={{ inputLabel: { shrink: true } }}
              value={backfillFrom}
              onChange={(e) => setBackfillFrom(e.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              label="To (capture date)"
              type="date"
              size="small"
              slotProps={{ inputLabel: { shrink: true } }}
              value={backfillTo}
              onChange={(e) => setBackfillTo(e.target.value)}
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
            label="Force re-geocode all (overwrite existing resolved locations)"
            sx={{ mb: 2, display: 'block' }}
          />

          <Button
            variant="contained"
            disabled={backfillLoading}
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
        autoHideDuration={5000}
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

export default function GeoSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <GeoSettingsContent />;
}
