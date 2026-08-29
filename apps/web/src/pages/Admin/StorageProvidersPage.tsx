/**
 * Admin → Storage Providers (`/admin/settings/storage/providers`).
 *
 * Migrated onto the shared DataTable in issue #259 (epic #238). Two surfaces
 * changed here:
 *
 *   1. **Provider rows.** The three stacked credential CARDS became one table
 *      (`./storageProvidersTable.tsx`), with the credential form moved behind a
 *      per-row "Configure…" dialog. The old layout made the reader scroll past
 *      six text fields per provider to compare which one was active, which had a
 *      bucket set, and which was even configured — the exact comparison a table
 *      answers in one glance and a stack of forms never does. Every mutation is
 *      unchanged: the same `saveCredentials` / `removeCredentials` /
 *      `testProvider` calls, with the same "blank secret means keep the stored
 *      one" semantics and the same pre-save test guard.
 *   2. **Migration run history.** A hand-rolled seven-column `<Table>` became a
 *      DataTable with `status` as a `primary` column (issue #259's decision).
 *
 * The active-provider radio group and the migration start form are NOT tables
 * and are untouched.
 */

import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  RadioGroup,
  Radio,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import CloudIcon from '@mui/icons-material/Cloud';
import SettingsIcon from '@mui/icons-material/Settings';
import TestIcon from '@mui/icons-material/NetworkCheck';
import DeleteIcon from '@mui/icons-material/Delete';
import { usePermissions } from '../../hooks/usePermissions';
import { useStorageProviders } from '../../hooks/useStorageProviders';
import { useStorageMigration } from '../../hooks/useStorageMigration';
import type {
  MigrationRun,
  StorageProviderRow,
  StorageTestResult,
} from '../../services/storage-providers';
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import {
  MIGRATION_RUN_COLUMNS,
  MigrationStatusChip,
  STORAGE_MIGRATIONS_TABLE_ID,
  STORAGE_PROVIDERS_TABLE_ID,
  buildStorageProviderColumns,
  providerLabel,
} from './storageProvidersTable';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';

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

/**
 * Whether a provider still needs a secret typed in before it can be tested.
 *
 * Unchanged rule, lifted verbatim out of the old card: a provider that requires
 * credentials and has never been saved has nothing on the server to test with.
 */
function needsSecretBeforeTest(
  row: StorageProviderRow,
  form: ProviderFormState | undefined,
): boolean {
  return row.requiresCredentials && !row.configured && !form?.secretAccessKey;
}

// ---------------------------------------------------------------------------
// Test result line (shared by the dialog and the local-disk row)
// ---------------------------------------------------------------------------

function TestResultLine({ result, local }: { result: StorageTestResult; local?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
      {result.ok ? (
        <CheckCircleIcon color="success" fontSize="small" />
      ) : (
        <ErrorIcon color="error" fontSize="small" />
      )}
      <Typography variant="body2" color={result.ok ? 'success.main' : 'error.main'}>
        {result.ok
          ? local
            ? 'Accessible'
            : `Connected${result.bucket ? ` — bucket: ${result.bucket}` : ''}`
          : (result.error ?? 'Test failed')}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Configure dialog — the credential form that used to be a card
// ---------------------------------------------------------------------------

interface ConfigureProviderDialogProps {
  providerConfig: StorageProviderRow | null;
  formState: ProviderFormState | undefined;
  onFormChange: (key: string, field: string, value: string | boolean) => void;
  onSave: (provider: string) => Promise<void>;
  onTest: (provider: string) => Promise<void>;
  testResult: StorageTestResult | null;
  testLoading: boolean;
  onClose: () => void;
}

function ConfigureProviderDialog({
  providerConfig,
  formState,
  onFormChange,
  onSave,
  onTest,
  testResult,
  testLoading,
  onClose,
}: ConfigureProviderDialogProps) {
  if (!providerConfig) {
    return <Dialog open={false} onClose={onClose} />;
  }

  const key = providerConfig.provider;
  const isLocal = key === 'local';
  const isR2 = key === 'r2';
  const form = formState ?? defaultFormState(providerConfig);
  const testBlocked = needsSecretBeforeTest(providerConfig, form);

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{providerLabel(key)}</DialogTitle>
      <DialogContent>
        {isLocal ? (
          <Box sx={{ pt: 1 }}>
            <Alert severity="info" icon={false} sx={{ py: 0.5, mb: 2 }}>
              No credentials required — files are stored on the server&apos;s local filesystem.
            </Alert>
            {testResult != null && <TestResultLine result={testResult} local />}
          </Box>
        ) : (
          <Box sx={{ pt: 1 }}>
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

            <TextField
              label="Access Key ID"
              size="small"
              fullWidth
              value={form.accessKeyId ?? ''}
              onChange={(e) => onFormChange(key, 'accessKeyId', e.target.value)}
              placeholder={
                providerConfig.configured ? 'Leave blank to keep current' : 'Enter Access Key ID'
              }
              sx={{ mb: 2 }}
            />

            <TextField
              label="New Secret Access Key"
              type="password"
              size="small"
              fullWidth
              value={form.secretAccessKey ?? ''}
              onChange={(e) => onFormChange(key, 'secretAccessKey', e.target.value)}
              placeholder={
                providerConfig.configured
                  ? 'Leave blank to keep current secret'
                  : 'Enter Secret Access Key'
              }
              helperText={
                providerConfig.configured
                  ? 'Leave blank to use the saved secret when testing or saving.'
                  : undefined
              }
              sx={{ mb: 2 }}
            />

            <TextField
              label="Bucket"
              size="small"
              fullWidth
              value={form.bucket ?? ''}
              onChange={(e) => onFormChange(key, 'bucket', e.target.value)}
              placeholder="my-bucket"
              sx={{ mb: 2 }}
            />

            <TextField
              label="Region"
              size="small"
              fullWidth
              value={form.region ?? ''}
              onChange={(e) => onFormChange(key, 'region', e.target.value)}
              placeholder={isR2 ? 'auto' : 'us-east-1'}
              sx={{ mb: 2 }}
            />

            <TextField
              label="Endpoint URL"
              size="small"
              fullWidth
              value={form.endpoint ?? ''}
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

            <FormControlLabel
              control={
                <Switch
                  checked={form.enabled ?? providerConfig.enabled}
                  onChange={(e) => onFormChange(key, 'enabled', e.target.checked)}
                />
              }
              label="Enabled"
              sx={{ mb: 2, display: 'block' }}
            />

            {testBlocked && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Enter the Secret Access Key to test before saving.
              </Typography>
            )}

            {testResult != null && <TestResultLine result={testResult} />}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 3, pb: 2 }}>
        <Button
          variant="outlined"
          size="small"
          disabled={testLoading || testBlocked}
          title={testBlocked ? 'Enter the Secret Access Key to test before saving' : undefined}
          startIcon={testLoading ? <CircularProgress size={14} /> : undefined}
          onClick={() => void onTest(key)}
        >
          Test connection
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
        {!isLocal && (
          <Button variant="contained" size="small" onClick={() => void onSave(key)}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
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

  // The provider whose credential dialog is open
  const [configureProvider, setConfigureProvider] = useState<string | null>(null);

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
    setConfigureProvider(null);
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
      const result = await testProvider(provider, {
        accessKeyId: form?.accessKeyId || undefined,
        secretAccessKey: form?.secretAccessKey || undefined,
        bucket: form?.bucket || undefined,
        region: form?.region || undefined,
        endpoint: form?.endpoint || undefined,
      });
      // The dialog shows the result inline; a test launched from the row menu
      // has nowhere to show it, so it also lands in the snackbar.
      if (result.ok) {
        setSuccessMessage(`${providerLabel(provider)} connection OK`);
      } else {
        setLocalError(result.error ?? `${providerLabel(provider)} test failed`);
      }
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
  // Table wiring
  // ---------------------------------------------------------------------------

  const providerColumns = useMemo(
    () => buildStorageProviderColumns(settings?.activeProvider),
    [settings?.activeProvider],
  );

  const providerActions = useMemo<DataTableRowAction<StorageProviderRow>[]>(
    () => [
      {
        id: 'configure',
        label: 'Configure',
        icon: <SettingsIcon fontSize="small" />,
        onClick: (row) => setConfigureProvider(row.provider),
      },
      {
        id: 'test',
        label: 'Test connection',
        icon: <TestIcon fontSize="small" />,
        disabled: (row) =>
          (testLoading[row.provider] ?? false) || needsSecretBeforeTest(row, formMap[row.provider]),
        onClick: (row) => void handleTest(row.provider),
      },
      {
        id: 'remove',
        label: 'Remove',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        disabled: (row) => !row.configured || row.provider === 'local',
        confirm: {
          title: 'Remove credentials?',
          description: (row) =>
            `Remove credentials for ${providerLabel(row.provider)}? This will disable this provider.`,
          confirmLabel: 'Remove',
        },
        onClick: (row) => void handleRemove(row.provider),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [testLoading, formMap],
  );

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
  const configureRow = providers.find((p) => p.provider === configureProvider) ?? null;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          icon={<CloudIcon color="primary" />}
          title={<>Storage Providers</>}
          description={
            <>
              Configure storage providers for new uploads, manage credentials, and migrate existing
              files between providers.
            </>
          }
        />

        {/* ------------------------------------------------------------------ */}
        {/* Provider rows                                                       */}
        {/* ------------------------------------------------------------------ */}
        <DataTable<StorageProviderRow>
          columns={providerColumns}
          rows={providers}
          rowId={(row) => row.provider}
          tableId={STORAGE_PROVIDERS_TABLE_ID}
          ariaLabel="Storage providers"
          density="compact"
          loading={loading}
          emptyState={<span>No storage providers available</span>}
          rowActions={providerActions}
          csvExport={{ filename: 'storage-providers' }}
        />

        {/* ------------------------------------------------------------------ */}
        {/* Active provider selector                                            */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 3, mt: 3, mb: 2 }}>
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
                <MigrationStatusChip status={activeRun.status} />
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
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
              <FormControl size="small" sx={{ minWidth: 160 }}>
                <InputLabel id="migration-source-label">Source provider</InputLabel>
                <Select
                  labelId="migration-source-label"
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
                <InputLabel id="migration-target-label">Target provider</InputLabel>
                <Select
                  labelId="migration-target-label"
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
              <DataTable<MigrationRun>
                columns={MIGRATION_RUN_COLUMNS}
                rows={runs}
                rowId={(run) => run.id}
                tableId={STORAGE_MIGRATIONS_TABLE_ID}
                ariaLabel="Migration runs"
                density="compact"
                loading={runsLoading}
                emptyState={<span>No migration runs yet</span>}
                csvExport={{ filename: 'storage-migration-runs' }}
              />
            </Box>
          )}
        </Paper>
      </Box>

      {/* -------------------------------------------------------------------- */}
      {/* Configure provider dialog (the old card, per row)                     */}
      {/* -------------------------------------------------------------------- */}
      <ConfigureProviderDialog
        providerConfig={configureRow}
        formState={configureProvider ? formMap[configureProvider] : undefined}
        onFormChange={onFormChange}
        onSave={handleSave}
        onTest={handleTest}
        testResult={configureProvider ? (testResults[configureProvider] ?? null) : null}
        testLoading={configureProvider ? (testLoading[configureProvider] ?? false) : false}
        onClose={() => setConfigureProvider(null)}
      />

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
