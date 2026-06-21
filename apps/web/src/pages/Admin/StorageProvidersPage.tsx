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
  LinearProgress,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  RadioGroup,
  Radio,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Cloud as CloudIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useStorageProviders } from '../../hooks/useStorageProviders';
import { useStorageMigration } from '../../hooks/useStorageMigration';
import type { StorageProviderRow } from '../../services/storage-providers';

// ---------------------------------------------------------------------------
// Helper: human-readable provider label
// ---------------------------------------------------------------------------

function providerLabel(key: string): string {
  switch (key) {
    case 's3':
      return 'AWS S3';
    case 'r2':
      return 'Cloudflare R2';
    case 'local':
      return 'Local Disk';
    default:
      return key.toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// Helper: migration status chip
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: string }) {
  const colorMap: Record<string, 'default' | 'warning' | 'info' | 'success' | 'error'> = {
    pending: 'warning',
    running: 'info',
    completed: 'success',
    failed: 'error',
    cancelled: 'default',
  };
  return (
    <Chip
      label={status}
      color={colorMap[status] ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  providerConfig: StorageProviderRow;
  isActive: boolean;
  formState: ProviderFormState;
  onFormChange: (key: string, field: string, value: string | boolean) => void;
  onSave: (provider: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
  onTest: (provider: string) => Promise<void>;
  testResult: { ok: boolean; error?: string } | null;
  testLoading: boolean;
}

function ProviderCard({
  providerConfig,
  isActive,
  formState,
  onFormChange,
  onSave,
  onRemove,
  onTest,
  testResult,
  testLoading,
}: ProviderCardProps) {
  const key = providerConfig.provider;
  const isLocal = key === 'local';
  const isR2 = key === 'r2';

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h6">{providerLabel(key)}</Typography>
        {isActive && (
          <Chip label="Active" color="primary" size="small" />
        )}
        <Chip
          label={providerConfig.enabled ? 'Enabled' : 'Disabled'}
          color={providerConfig.enabled ? 'success' : 'default'}
          size="small"
          variant="outlined"
        />
        {providerConfig.configured && (
          <Chip label="Configured" color="info" size="small" variant="outlined" />
        )}
      </Box>

      {isLocal ? (
        /* Local disk — no credential fields */
        <Box>
          <Alert severity="info" icon={false} sx={{ py: 0.5, mb: 2 }}>
            No credentials required — files are stored on the server's local filesystem.
          </Alert>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              size="small"
              disabled={testLoading}
              startIcon={testLoading ? <CircularProgress size={14} /> : undefined}
              onClick={() => void onTest(key)}
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
                {testResult.ok ? 'Accessible' : (testResult.error ?? 'Test failed')}
              </Typography>
            </Box>
          )}
        </Box>
      ) : (
        <>
          {/* Masked current secret */}
          {providerConfig.configured && providerConfig.last4 && (
            <TextField
              label="Current Secret Access Key"
              value={`••••••••${providerConfig.last4}`}
              size="small"
              fullWidth
              disabled
              sx={{ mb: 2 }}
            />
          )}

          {/* Access Key ID */}
          <TextField
            label="Access Key ID"
            size="small"
            fullWidth
            value={formState.accessKeyId ?? ''}
            onChange={(e) => onFormChange(key, 'accessKeyId', e.target.value)}
            placeholder={providerConfig.configured ? 'Leave blank to keep current' : 'Enter Access Key ID'}
            sx={{ mb: 2 }}
          />

          {/* New Secret Access Key */}
          <TextField
            label="New Secret Access Key"
            type="password"
            size="small"
            fullWidth
            value={formState.secretAccessKey ?? ''}
            onChange={(e) => onFormChange(key, 'secretAccessKey', e.target.value)}
            placeholder={providerConfig.configured ? 'Leave blank to keep current secret' : 'Enter Secret Access Key'}
            sx={{ mb: 2 }}
          />

          {/* Bucket */}
          <TextField
            label="Bucket"
            size="small"
            fullWidth
            value={formState.bucket ?? ''}
            onChange={(e) => onFormChange(key, 'bucket', e.target.value)}
            placeholder="my-bucket"
            sx={{ mb: 2 }}
          />

          {/* Region */}
          <TextField
            label="Region"
            size="small"
            fullWidth
            value={formState.region ?? ''}
            onChange={(e) => onFormChange(key, 'region', e.target.value)}
            placeholder={isR2 ? 'auto' : 'us-east-1'}
            sx={{ mb: 2 }}
          />

          {/* Endpoint (R2 requires it; S3 optional) */}
          <TextField
            label="Endpoint URL"
            size="small"
            fullWidth
            value={formState.endpoint ?? ''}
            onChange={(e) => onFormChange(key, 'endpoint', e.target.value)}
            placeholder={
              isR2
                ? 'https://<account-id>.r2.cloudflarestorage.com'
                : 'Leave blank for AWS default'
            }
            helperText={
              isR2
                ? 'Required for Cloudflare R2 — find this in the R2 dashboard.'
                : 'Optional — set only for S3-compatible endpoints.'
            }
            required={isR2}
            sx={{ mb: 2 }}
          />

          {/* Enabled toggle */}
          <FormControlLabel
            control={
              <Switch
                checked={formState.enabled ?? providerConfig.enabled}
                onChange={(e) => onFormChange(key, 'enabled', e.target.checked)}
              />
            }
            label="Enabled"
            sx={{ mb: 2, display: 'block' }}
          />

          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="contained"
              size="small"
              onClick={() => void onSave(key)}
            >
              Save
            </Button>
            {providerConfig.configured && (
              <Button
                variant="outlined"
                size="small"
                color="error"
                onClick={() => void onRemove(key)}
              >
                Remove
              </Button>
            )}
            <Button
              variant="outlined"
              size="small"
              disabled={testLoading}
              startIcon={testLoading ? <CircularProgress size={14} /> : undefined}
              onClick={() => void onTest(key)}
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
                  ? `Connected${testResult.bucket ? ` — bucket: ${testResult.bucket}` : ''}`
                  : (testResult.error ?? 'Test failed')}
              </Typography>
            </Box>
          )}
        </>
      )}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Per-provider form shape
// ---------------------------------------------------------------------------

interface ProviderFormState {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
  enabled: boolean;
}

type ProviderFormMap = Record<string, ProviderFormState>;

function defaultFormState(row: StorageProviderRow): ProviderFormState {
  return {
    accessKeyId: row.accessKeyId ?? '',
    secretAccessKey: '',
    bucket: row.bucket ?? '',
    region: row.region ?? '',
    endpoint: row.endpoint ?? '',
    enabled: row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Main content
// ---------------------------------------------------------------------------

function StorageProvidersContent() {
  const {
    settings,
    loading,
    error,
    testResults,
    testLoading,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    setActive,
  } = useStorageProviders();

  const {
    runs,
    runsLoading,
    runsError,
    activeRun,
    starting,
    refresh: refreshRuns,
    startMigration,
    cancel: cancelMigration,
  } = useStorageMigration();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Per-provider form state
  const [formMap, setFormMap] = useState<ProviderFormMap>({});

  // Active provider radio selection
  const [activeProviderLocal, setActiveProviderLocal] = useState('');
  const [savingActive, setSavingActive] = useState(false);

  // Migration form
  const [migSource, setMigSource] = useState('');
  const [migTarget, setMigTarget] = useState('');
  const [migConfirmOpen, setMigConfirmOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Load settings
  // ---------------------------------------------------------------------------

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (!settings) return;
    const all = allProviders(settings);
    // Initialize form state from settings
    const map: ProviderFormMap = {};
    all.forEach((p) => {
      map[p.provider] = defaultFormState(p);
    });
    setFormMap(map);
    setActiveProviderLocal(settings.activeProvider ?? '');
  }, [settings]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function allProviders(s: typeof settings) {
    if (!s) return [];
    // Deduplicate by key (providers = configured, knownProviders = all known)
    const seen = new Set<string>();
    const result: StorageProviderRow[] = [];
    for (const p of [...(s.providers ?? []), ...(s.knownProviders ?? [])]) {
      if (!seen.has(p.provider)) {
        seen.add(p.provider);
        result.push(p);
      }
    }
    return result;
  }

  const providers = allProviders(settings);

  const onFormChange = (key: string, field: string, value: string | boolean) => {
    setFormMap((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSave = async (provider: string) => {
    const form = formMap[provider];
    if (!form) return;
    try {
      await saveCredentials(provider, {
        ...(form.accessKeyId ? { accessKeyId: form.accessKeyId } : {}),
        ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}),
        bucket: form.bucket || undefined,
        region: form.region || undefined,
        endpoint: form.endpoint || undefined,
        enabled: form.enabled,
      });
      // Clear secret field after save
      setFormMap((prev) => ({
        ...prev,
        [provider]: { ...prev[provider], secretAccessKey: '' },
      }));
      setSuccessMessage(`${providerLabel(provider)} credentials saved`);
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save credentials');
    }
  };

  const handleRemove = async (provider: string) => {
    if (
      !window.confirm(
        `Remove credentials for ${providerLabel(provider)}? This will disable this provider.`,
      )
    )
      return;
    try {
      await removeCredentials(provider);
      setSuccessMessage(`${providerLabel(provider)} credentials removed`);
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to remove credentials');
    }
  };

  const handleTest = async (provider: string) => {
    const form = formMap[provider];
    try {
      await testProvider(provider, {
        accessKeyId: form?.accessKeyId || undefined,
        secretAccessKey: form?.secretAccessKey || undefined,
        bucket: form?.bucket || undefined,
        region: form?.region || undefined,
        endpoint: form?.endpoint || undefined,
      });
    } catch {
      // result is captured inside testProvider
    }
  };

  const handleSaveActive = async () => {
    if (!activeProviderLocal) return;
    setSavingActive(true);
    try {
      await setActive(activeProviderLocal);
      setSuccessMessage(`Active provider set to ${providerLabel(activeProviderLocal)}`);
      await fetchSettings();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to set active provider');
    } finally {
      setSavingActive(false);
    }
  };

  const handleStartMigration = async () => {
    setMigConfirmOpen(false);
    try {
      await startMigration(migSource, migTarget);
      setSuccessMessage('Migration started — copying files in the background');
      await refreshRuns();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to start migration');
    }
  };

  const handleCancelMigration = async () => {
    try {
      await cancelMigration();
      setSuccessMessage('Migration cancelled');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to cancel migration');
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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

  const providerKeys = providers.map((p) => p.provider);
  const migrationInProgress =
    activeRun != null && (activeRun.status === 'pending' || activeRun.status === 'running');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <CloudIcon color="primary" />
          <Typography variant="h4" component="h1">
            Storage Providers
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure storage providers for new uploads, manage credentials, and migrate existing
          files between providers.
        </Typography>

        {/* ------------------------------------------------------------------ */}
        {/* Provider cards                                                      */}
        {/* ------------------------------------------------------------------ */}
        {providers.map((p) => (
          <ProviderCard
            key={p.provider}
            providerConfig={p}
            isActive={settings?.activeProvider === p.provider}
            formState={formMap[p.provider] ?? defaultFormState(p)}
            onFormChange={onFormChange}
            onSave={handleSave}
            onRemove={handleRemove}
            onTest={handleTest}
            testResult={testResults[p.provider] ?? null}
            testLoading={testLoading[p.provider] ?? false}
          />
        ))}

        {/* ------------------------------------------------------------------ */}
        {/* Active provider selector                                            */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Active Provider for New Uploads
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Switching the active provider only affects NEW uploads. Existing files continue to be
            served from the provider where they are stored.
          </Typography>

          <FormControl component="fieldset" sx={{ mb: 2 }}>
            <RadioGroup
              value={activeProviderLocal}
              onChange={(e) => setActiveProviderLocal(e.target.value)}
            >
              {providerKeys.map((key) => (
                <FormControlLabel
                  key={key}
                  value={key}
                  control={<Radio size="small" />}
                  label={providerLabel(key)}
                />
              ))}
            </RadioGroup>
          </FormControl>

          <Button
            variant="contained"
            size="small"
            disabled={
              !activeProviderLocal ||
              activeProviderLocal === settings?.activeProvider ||
              savingActive
            }
            startIcon={savingActive ? <CircularProgress size={14} /> : undefined}
            onClick={() => void handleSaveActive()}
          >
            Save Active Provider
          </Button>
        </Paper>

        {/* ------------------------------------------------------------------ */}
        {/* Migration panel                                                     */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Migrate Files Between Providers
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Files are copied to the target provider; originals are left in place as a fallback.
            Switching the active provider is a separate step — do that above after migration
            completes.
          </Typography>

          {/* Active run progress */}
          {activeRun && (
            <Box sx={{ mb: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Migration in progress
                </Typography>
                <StatusChip status={activeRun.status} />
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {providerLabel(activeRun.sourceProvider)} → {providerLabel(activeRun.targetProvider)}
              </Typography>
              <LinearProgress
                variant={activeRun.totalCount > 0 ? 'determinate' : 'indeterminate'}
                value={
                  activeRun.totalCount > 0
                    ? Math.round((activeRun.migratedCount / activeRun.totalCount) * 100)
                    : 0
                }
                sx={{ mb: 1 }}
              />
              <Stack direction="row" spacing={2}>
                <Typography variant="caption">
                  Copied: {activeRun.migratedCount} / {activeRun.totalCount}
                </Typography>
                {activeRun.failedCount > 0 && (
                  <Typography variant="caption" color="error">
                    Failed: {activeRun.failedCount}
                  </Typography>
                )}
                {activeRun.skippedCount > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Skipped: {activeRun.skippedCount}
                  </Typography>
                )}
              </Stack>
              {activeRun.lastError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {activeRun.lastError}
                </Alert>
              )}
              {migrationInProgress && (
                <Button
                  variant="outlined"
                  color="error"
                  size="small"
                  sx={{ mt: 1 }}
                  onClick={() => void handleCancelMigration()}
                >
                  Cancel Migration
                </Button>
              )}
            </Box>
          )}

          {/* Start migration form */}
          {!migrationInProgress && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
              <FormControl size="small" sx={{ minWidth: 160 }}>
                <InputLabel>Source provider</InputLabel>
                <Select
                  label="Source provider"
                  value={migSource}
                  onChange={(e) => setMigSource(e.target.value)}
                >
                  <MenuItem value="">Select source</MenuItem>
                  {providerKeys.map((key) => (
                    <MenuItem key={key} value={key}>
                      {providerLabel(key)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" sx={{ minWidth: 160 }}>
                <InputLabel>Target provider</InputLabel>
                <Select
                  label="Target provider"
                  value={migTarget}
                  onChange={(e) => setMigTarget(e.target.value)}
                >
                  <MenuItem value="">Select target</MenuItem>
                  {providerKeys
                    .filter((k) => k !== migSource)
                    .map((key) => (
                      <MenuItem key={key} value={key}>
                        {providerLabel(key)}
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>

              <Button
                variant="contained"
                disabled={!migSource || !migTarget || migSource === migTarget || starting}
                startIcon={starting ? <CircularProgress size={14} /> : undefined}
                onClick={() => setMigConfirmOpen(true)}
                sx={{ mt: { xs: 0, sm: '4px' } }}
              >
                Start Migration
              </Button>
            </Stack>
          )}

          {/* Run history */}
          {runsError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {runsError}
            </Alert>
          )}

          {runs.length > 0 && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Recent Migration Runs
              </Typography>
              <Paper variant="outlined">
                {runsLoading ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress size={24} />
                  </Box>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Route</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Copied</TableCell>
                        <TableCell align="right">Failed</TableCell>
                        <TableCell align="right">Skipped</TableCell>
                        <TableCell>Started</TableCell>
                        <TableCell>Finished</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {runs.map((run) => (
                        <TableRow key={run.id}>
                          <TableCell>
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
                            >
                              {providerLabel(run.sourceProvider)} →{' '}
                              {providerLabel(run.targetProvider)}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <StatusChip status={run.status} />
                          </TableCell>
                          <TableCell align="right">
                            <Typography variant="body2">{run.migratedCount}</Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Chip
                              label={run.failedCount}
                              size="small"
                              color={run.failedCount > 0 ? 'error' : 'default'}
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Typography variant="body2">{run.skippedCount}</Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2">
                              {run.startedAt
                                ? new Date(run.startedAt).toLocaleString()
                                : '—'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2">
                              {run.finishedAt
                                ? new Date(run.finishedAt).toLocaleString()
                                : '—'}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Paper>
            </Box>
          )}
        </Paper>
      </Box>

      {/* -------------------------------------------------------------------- */}
      {/* Confirmation dialog                                                   */}
      {/* -------------------------------------------------------------------- */}
      <Dialog open={migConfirmOpen} onClose={() => setMigConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Start Migration?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will copy all files from <strong>{providerLabel(migSource)}</strong> to{' '}
            <strong>{providerLabel(migTarget)}</strong>. Originals are left in place as a
            fallback — no files will be deleted. Migration runs in the background and may take
            a while depending on library size.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMigConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleStartMigration()}>
            Start Migration
          </Button>
        </DialogActions>
      </Dialog>

      {/* -------------------------------------------------------------------- */}
      {/* Snackbars                                                             */}
      {/* -------------------------------------------------------------------- */}
      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />
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

// ---------------------------------------------------------------------------
// Page wrapper with admin gate
// ---------------------------------------------------------------------------

export default function StorageProvidersPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <StorageProvidersContent />;
}
