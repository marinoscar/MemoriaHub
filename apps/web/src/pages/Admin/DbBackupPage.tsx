/**
 * Admin → Database Backup (`/admin/settings/db-backup`).
 *
 * Issue #345 (epic #339). Consumes the #343 admin API:
 *
 *   - Config panel — schedule (frequency + the conditional day picker), time of
 *     day, timezone, retention (with the storage cost that retention actually
 *     commits to), storage-provider override, and the restore rollback mode.
 *     The server's COMPUTED `nextRunAt` is shown so an admin can confirm a
 *     schedule means what they think before waiting a day to find out.
 *   - Run controls — "Back up now" (disabled while a run holds the slot), and
 *     Cancel for an in-flight run.
 *   - Live progress — a real byte counter, elapsed time, and heartbeat
 *     freshness, polled every 5s. NOT an indeterminate spinner: a legitimate
 *     40-minute dump has to look alive, or an admin assumes it hung and
 *     interferes with it.
 *   - Run history — the shared DataTable with Download / Delete row actions.
 *
 * ## Restore is #344 and is NOT built here
 *
 * `POST /runs/:id/restore` and `POST /runs/:id/rollback` do not exist yet. The
 * Restore row action is rendered but permanently disabled with a reason, and
 * the restore dialog, pre-flight display, two-phase progress, rollback
 * surfacing, and guided-fallback command block are all deferred — see the
 * `TODO(#344)` below. Nothing here guesses at that API's shape.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  Link,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  Backup as BackupIcon,
  Download as DownloadIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  SettingsBackupRestore as RestoreIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useDbBackup } from '../../hooks/useDbBackup';
import { getStorageSettings } from '../../services/storage-providers';
import type { StorageProviderRow } from '../../services/storage-providers';
import type {
  DbBackupConfig,
  DbBackupFrequency,
  DbBackupRollbackMode,
  DbBackupRunDto,
} from '../../services/dbBackup';
import { DataTable } from '../../components/datatable';
import type { DataTableRowAction } from '../../components/datatable';
import {
  DB_BACKUP_RUNS_TABLE_ID,
  buildDbBackupRunColumns,
  displayStatus,
} from './dbBackupTable';
import { formatBytes, formatDuration, relativeTime } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * IANA timezone options, with a fallback for runtimes without
 * `Intl.supportedValuesOf` (ES2022; the app's lib target is ES2020).
 * Same narrow cast as `NodeBackupPage.supportedTimezones`.
 */
export function supportedTimezones(fallback: string): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  if (typeof intl.supportedValuesOf === 'function') {
    return intl.supportedValuesOf('timeZone');
  }
  return Array.from(new Set([fallback, 'UTC']));
}

/**
 * The provider a backup would actually land on: the explicit override when set,
 * otherwise whatever is currently active for new uploads.
 *
 * This is what the `local` warning keys off — an admin who leaves the override
 * on "Use active provider" while the active provider is local disk is one disk
 * failure away from losing the database and its backups together, and the
 * config panel is the only place that fact is visible before it matters.
 */
export function resolveEffectiveProvider(
  override: string | null,
  activeProvider: string | null,
): string | null {
  return override ?? activeProvider;
}

/**
 * Estimated total storage the retention setting commits to: the last dump's
 * size × how many are kept.
 *
 * A bare "7" gives no signal about the cost. BigInt throughout — `sizeBytes` is
 * a BigInt-safe string and multiplying it as a float would silently drift on a
 * multi-GB dump.
 */
export function estimateRetentionBytes(
  lastSizeBytes: string | null,
  retentionCount: number,
): string | null {
  if (!lastSizeBytes) return null;
  try {
    return (BigInt(lastSizeBytes) * BigInt(Math.max(1, retentionCount))).toString();
  } catch {
    return null;
  }
}

/** Most recent run that produced a real archive, for the size estimate. */
export function lastCompletedSize(runs: DbBackupRunDto[]): string | null {
  const done = runs.find((r) => r.status === 'completed' && r.sizeBytes);
  return done?.sizeBytes ?? null;
}

/**
 * Heartbeat freshness of an in-flight run.
 *
 * `fresh` while the last heartbeat is inside the stale window, `stale` past it
 * — and `unknown` when a claimed run has not written one yet. The distinction
 * matters: "no heartbeat yet" is normal for the first seconds of a run and
 * must not be painted as the failure state.
 */
export function heartbeatFreshness(
  lastHeartbeatAt: string | null,
  runStaleMinutes: number,
  now: number = Date.now(),
): { state: 'fresh' | 'stale' | 'unknown'; ageMs: number | null } {
  if (!lastHeartbeatAt) return { state: 'unknown', ageMs: null };
  const ageMs = now - new Date(lastHeartbeatAt).getTime();
  return {
    state: ageMs > runStaleMinutes * 60_000 ? 'stale' : 'fresh',
    ageMs,
  };
}

// ---------------------------------------------------------------------------
// Small display helper
// ---------------------------------------------------------------------------

function StatItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 150 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Page content
// ---------------------------------------------------------------------------

function DbBackupPageContent() {
  const {
    config,
    nextRunAt,
    activeRunId,
    activeRun,
    configLoaded,
    runs,
    total,
    page,
    pageSize,
    loading,
    saving,
    starting,
    error,
    conflictRunId,
    setPage,
    setPageSize,
    refresh,
    saveConfig,
    startRun,
    cancelRun,
    deleteRun,
    downloadRun,
  } = useDbBackup();

  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('db_backup:write');
  const canRestore = hasPermission('db_backup:restore');

  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );
  const timezoneOptions = useMemo(() => supportedTimezones(browserTz), [browserTz]);

  // --- Form state ------------------------------------------------------------
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<DbBackupFrequency>('daily');
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timeOfDay, setTimeOfDay] = useState('02:00');
  const [timezone, setTimezone] = useState('UTC');
  const [retentionCount, setRetentionCount] = useState(7);
  const [storageProvider, setStorageProvider] = useState<string>('');
  const [rollbackMode, setRollbackMode] =
    useState<DbBackupRollbackMode>('retain_database');
  const [oldDbRetentionHours, setOldDbRetentionHours] = useState(168);

  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Initialize the form ONCE from the first loaded config: the 5s progress poll
  // keeps refreshing state around it and must never clobber an in-progress edit.
  const formInitialized = useRef(false);
  useEffect(() => {
    if (!configLoaded || !config || formInitialized.current) return;
    formInitialized.current = true;
    applyConfigToForm(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded, config]);

  function applyConfigToForm(c: DbBackupConfig) {
    setEnabled(c.enabled);
    setFrequency(c.frequency);
    setDayOfWeek(c.dayOfWeek);
    setDayOfMonth(c.dayOfMonth);
    setTimeOfDay(c.timeOfDay);
    setTimezone(c.timezone);
    setRetentionCount(c.retentionCount);
    setStorageProvider(c.storageProvider ?? '');
    setRollbackMode(c.restoreRollbackMode);
    setOldDbRetentionHours(c.oldDatabaseRetentionHours);
  }

  // --- Storage providers (for the override select + the `local` warning) -----
  const [providers, setProviders] = useState<StorageProviderRow[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getStorageSettings()
      .then((resp) => {
        if (cancelled) return;
        setProviders(resp.providers);
        setActiveProvider(resp.activeProvider);
      })
      .catch(() => {
        // Non-fatal: the override select degrades to the stored value only, and
        // the local-disk warning simply cannot be computed. Backup config must
        // stay editable when the storage-settings read fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveProvider = resolveEffectiveProvider(
    storageProvider === '' ? null : storageProvider,
    activeProvider,
  );
  const effectiveProviderIsLocal = effectiveProvider === 'local';

  // --- Retention cost --------------------------------------------------------
  const lastSize = lastCompletedSize(runs);
  const estimatedBytes = estimateRetentionBytes(lastSize, retentionCount);

  // --- Save ------------------------------------------------------------------
  const handleSave = useCallback(async () => {
    setFormError(null);
    try {
      await saveConfig({
        enabled,
        frequency,
        dayOfWeek,
        dayOfMonth,
        timeOfDay,
        timezone,
        retentionCount,
        storageProvider: storageProvider === '' ? null : storageProvider,
        restoreRollbackMode: rollbackMode,
        oldDatabaseRetentionHours: oldDbRetentionHours,
      });
      setSuccessMessage('Database backup settings saved');
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Failed to save backup settings',
      );
    }
  }, [
    saveConfig,
    enabled,
    frequency,
    dayOfWeek,
    dayOfMonth,
    timeOfDay,
    timezone,
    retentionCount,
    storageProvider,
    rollbackMode,
    oldDbRetentionHours,
  ]);

  // --- Row actions -----------------------------------------------------------
  const [actionError, setActionError] = useState<string | null>(null);

  const handleDownload = useCallback(
    async (run: DbBackupRunDto) => {
      setActionError(null);
      try {
        const url = await downloadRun(run.id);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : 'Failed to get download URL',
        );
      }
    },
    [downloadRun],
  );

  const handleDelete = useCallback(
    async (run: DbBackupRunDto) => {
      setActionError(null);
      try {
        await deleteRun(run.id);
        setSuccessMessage('Backup deleted');
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to delete backup');
      }
    },
    [deleteRun],
  );

  const rowActions = useMemo<DataTableRowAction<DbBackupRunDto>[]>(
    () => [
      {
        id: 'download',
        label: 'Download',
        icon: <DownloadIcon fontSize="small" />,
        // Only a completed dump has bytes to sign a URL for; the API 400s on
        // anything else, so the affordance is disabled rather than allowed to
        // fail after the click.
        disabled: (run) => run.status !== 'completed',
        onClick: (run) => void handleDownload(run),
      },
      {
        id: 'restore',
        label: canRestore
          ? 'Restore (not yet available)'
          : 'Restore (requires db_backup:restore)',
        icon: <RestoreIcon fontSize="small" />,
        // TODO(#344): attach the restore dialog here — pre-flight results
        // (CREATEDB, free disk vs. the selected rollback mode, pgvector,
        // artifact verified, schema compatibility), the two-phase progress
        // (long scratch-DB rebuild with the app ONLINE, then the brief swap +
        // restart during which polling is EXPECTED to fail), the active
        // rollback plan stated before confirming, the post-restore rollback
        // surface with its expiry, and the guided command block for a failed
        // capability check. `POST /runs/:id/restore` does not exist yet, so
        // the action stays disabled rather than opening a dialog that could
        // only fail.
        disabled: () => true,
        onClick: () => undefined,
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // A pending/running row holds the active slot and its bytes are still
        // being written; the API refuses it and points at Cancel instead.
        disabled: (run) =>
          !canWrite || run.status === 'pending' || run.status === 'running',
        confirm: {
          title: 'Delete this backup?',
          description: (run) =>
            `The stored archive (${formatBytes(run.sizeBytes ?? run.bytesWritten)}) and its history row are removed permanently. This cannot be undone.`,
          confirmLabel: 'Delete',
        },
        onClick: (run) => void handleDelete(run),
      },
    ],
    [canWrite, canRestore, handleDownload, handleDelete],
  );

  const columns = useMemo(() => buildDbBackupRunColumns(), []);

  // --- Live progress ---------------------------------------------------------
  const staleMinutes = config?.runStaleMinutes ?? 30;
  const heartbeat = heartbeatFreshness(
    activeRun?.lastHeartbeatAt ?? null,
    staleMinutes,
  );
  const runIsStale = activeRun?.status === 'stale' || heartbeat.state === 'stale';

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
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
          <BackupIcon color="primary" />
          <Typography variant="h4" component="h1">
            Database Backup
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Scheduled <code>pg_dump</code> of the PostgreSQL database to object
          storage. This backs up the <strong>database only</strong> — media files
          are covered separately by Backup and by node Local Media Backup.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Run controls + live progress                                        */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }} id="db-backup-active-run">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
              Runs
            </Typography>
            {config && (
              <Chip
                label={config.enabled ? 'Schedule enabled' : 'Schedule disabled'}
                color={config.enabled ? 'success' : 'default'}
                size="small"
                variant="outlined"
              />
            )}
            <Button
              size="small"
              variant="outlined"
              startIcon={<RefreshIcon />}
              disabled={loading}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            <Button
              variant="contained"
              disabled={!canWrite || starting || !!activeRunId}
              onClick={() => void startRun()}
            >
              {starting ? 'Starting…' : 'Back up now'}
            </Button>
          </Box>

          {conflictRunId && (
            <Alert severity="info" sx={{ mb: 2 }}>
              A database backup is already in progress.{' '}
              <Link href="#db-backup-active-run" underline="always">
                View run {conflictRunId.slice(0, 8)}
              </Link>
            </Alert>
          )}
          {conflictRunId === null && !activeRunId && starting === false && null}

          {activeRunId && activeRun ? (
            <Box>
              <Stack
                direction="row"
                spacing={4}
                useFlexGap
                sx={{ flexWrap: 'wrap', rowGap: 2, mb: 2 }}
              >
                <StatItem label="Run">
                  <code>{activeRun.id.slice(0, 8)}</code>
                </StatItem>
                <StatItem label="Status">
                  <Chip
                    label={runIsStale ? 'stale' : displayStatus(activeRun)}
                    color={runIsStale ? 'warning' : 'info'}
                    size="small"
                  />
                </StatItem>
                <StatItem label="Written so far">
                  {formatBytes(activeRun.bytesWritten)}
                </StatItem>
                <StatItem label="Elapsed">
                  {formatDuration(activeRun.elapsedMs)}
                </StatItem>
                <StatItem label="Last heartbeat">
                  {heartbeat.state === 'unknown'
                    ? 'no heartbeat yet'
                    : `${relativeTime(activeRun.lastHeartbeatAt as string)}${
                        heartbeat.state === 'stale' ? ' (stale)' : ''
                      }`}
                </StatItem>
              </Stack>

              {/*
                Determinate-looking activity, not a spinner: the byte counter
                above is the real signal, and this bar exists only to show the
                run is still moving. A dump has no total to measure against, so
                the bar is honestly indeterminate while the numbers carry the
                information.
              */}
              <LinearProgress
                color={runIsStale ? 'warning' : 'primary'}
                sx={{ mb: 1 }}
              />

              {runIsStale ? (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  <AlertTitle>This run looks stale</AlertTitle>
                  No heartbeat for more than {staleMinutes} minutes. The process
                  running the dump may have died. Cancelling releases the
                  single-active-run slot so a new backup can start.
                </Alert>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  A full dump can legitimately take tens of minutes. As long as
                  the byte count and heartbeat keep advancing, the run is healthy
                  — leave it alone.
                </Typography>
              )}

              <Button
                size="small"
                color="warning"
                variant="outlined"
                disabled={!canWrite}
                onClick={() => void cancelRun(activeRun.id)}
              >
                Cancel run
              </Button>
            </Box>
          ) : activeRunId ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">
                Loading run progress…
              </Typography>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No backup is currently running.
              {nextRunAt
                ? ` Next scheduled run: ${new Date(nextRunAt).toLocaleString()}.`
                : ' No run is scheduled.'}
            </Typography>
          )}
        </Paper>

        {/* ------------------------------------------------------------------ */}
        {/* Config panel                                                        */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
            Configuration
          </Typography>

          {formError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setFormError(null)}>
              {formError}
            </Alert>
          )}

          <Stack spacing={2.5} sx={{ maxWidth: 560 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={saving || !canWrite}
                  slotProps={{ input: { 'aria-label': 'Scheduled backups enabled' } }}
                />
              }
              label="Scheduled backups enabled"
            />

            <FormControl fullWidth>
              <InputLabel id="db-backup-frequency-label">Frequency</InputLabel>
              <Select
                labelId="db-backup-frequency-label"
                label="Frequency"
                value={frequency}
                disabled={saving || !canWrite}
                onChange={(e) => setFrequency(e.target.value as DbBackupFrequency)}
              >
                <MenuItem value="daily">Daily</MenuItem>
                <MenuItem value="weekly">Weekly</MenuItem>
                <MenuItem value="monthly">Monthly</MenuItem>
              </Select>
            </FormControl>

            {/* The day picker is conditional on frequency: a day-of-week field
                on a daily schedule is a control with no effect. */}
            {frequency === 'weekly' && (
              <FormControl fullWidth>
                <InputLabel id="db-backup-dow-label">Day of week</InputLabel>
                <Select
                  labelId="db-backup-dow-label"
                  label="Day of week"
                  value={dayOfWeek}
                  disabled={saving || !canWrite}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                >
                  {DAY_NAMES.map((name, idx) => (
                    <MenuItem key={name} value={idx}>
                      {name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {frequency === 'monthly' && (
              <TextField
                label="Day of month"
                type="number"
                value={dayOfMonth}
                disabled={saving || !canWrite}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 1, max: 28 } }}
                helperText="1–28, so every month has the day (no skipped Februaries)"
                fullWidth
              />
            )}

            <TextField
              label="Time of day"
              type="time"
              value={timeOfDay}
              disabled={saving || !canWrite}
              onChange={(e) => setTimeOfDay(e.target.value)}
              slotProps={{ htmlInput: { step: 60 }, inputLabel: { shrink: true } }}
              fullWidth
            />

            <Autocomplete
              options={timezoneOptions}
              value={timezone}
              disabled={saving || !canWrite}
              onChange={(_e, next) => setTimezone(next ?? 'UTC')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Timezone"
                  helperText="IANA timezone the schedule is evaluated in"
                />
              )}
            />

            <Box>
              <TextField
                label="Backups to keep"
                type="number"
                value={retentionCount}
                disabled={saving || !canWrite}
                onChange={(e) => setRetentionCount(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 1, max: 100 } }}
                fullWidth
              />
              {/* A bare integer gives no signal about the storage bill this
                  commits to; the estimate does. */}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                {estimatedBytes
                  ? `Estimated total storage: ~${formatBytes(estimatedBytes)} (${retentionCount} × ${formatBytes(lastSize as string)}, the last completed dump).`
                  : 'Estimated total storage will appear once a backup has completed.'}
              </Typography>
            </Box>

            <Box>
              <FormControl fullWidth>
                <InputLabel id="db-backup-provider-label">
                  Storage provider
                </InputLabel>
                <Select
                  labelId="db-backup-provider-label"
                  label="Storage provider"
                  value={storageProvider}
                  disabled={saving || !canWrite}
                  onChange={(e) => setStorageProvider(e.target.value)}
                >
                  <MenuItem value="">
                    Use active provider
                    {activeProvider ? ` (${activeProvider})` : ''}
                  </MenuItem>
                  {providers.map((p) => (
                    <MenuItem key={p.provider} value={p.provider}>
                      {p.label}
                      {p.enabled ? '' : ' (disabled)'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {effectiveProviderIsLocal && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  <AlertTitle>Backups would land on local disk</AlertTitle>
                  A database backup stored on the same machine as the database
                  has no disaster-recovery value — a disk or host failure takes
                  the database and every backup of it at once. Point this at an
                  off-host provider (S3 or R2).
                </Alert>
              )}
            </Box>

            <Divider />

            <Box>
              <FormControl fullWidth>
                <InputLabel id="db-backup-rollback-label">Rollback mode</InputLabel>
                <Select
                  labelId="db-backup-rollback-label"
                  label="Rollback mode"
                  value={rollbackMode}
                  disabled={saving || !canWrite}
                  onChange={(e) =>
                    setRollbackMode(e.target.value as DbBackupRollbackMode)
                  }
                >
                  <MenuItem value="retain_database">
                    Keep the old database (fast rollback)
                  </MenuItem>
                  <MenuItem value="pre_restore_dump">
                    Take a pre-restore dump (cheap storage)
                  </MenuItem>
                </Select>
              </FormControl>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                {rollbackMode === 'retain_database'
                  ? 'The pre-restore database is renamed and kept, so rolling back takes seconds — at the cost of roughly 2× your PostgreSQL disk while it is retained.'
                  : 'Only a dump is kept before a restore, which costs almost no PostgreSQL disk — but rolling back means a full restore, i.e. hours of recovery.'}
              </Typography>
            </Box>

            {rollbackMode === 'retain_database' && (
              <TextField
                label="Keep the old database for (hours)"
                type="number"
                value={oldDbRetentionHours}
                disabled={saving || !canWrite}
                onChange={(e) => setOldDbRetentionHours(Number(e.target.value))}
                slotProps={{ htmlInput: { min: 1, max: 720 } }}
                helperText="How long the renamed pre-restore database stays available to roll back to"
                fullWidth
              />
            )}

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button
                variant="contained"
                disabled={saving || !canWrite}
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Typography variant="body2" color="text.secondary">
                {nextRunAt
                  ? `Next run: ${new Date(nextRunAt).toLocaleString()}`
                  : 'Next run: not scheduled'}
              </Typography>
            </Box>
          </Stack>
        </Paper>

        {/* ------------------------------------------------------------------ */}
        {/* Run history                                                         */}
        {/* ------------------------------------------------------------------ */}
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
          Backup history
        </Typography>
        <DataTable<DbBackupRunDto>
          columns={columns}
          rows={runs}
          rowId={(run) => run.id}
          tableId={DB_BACKUP_RUNS_TABLE_ID}
          ariaLabel="Database backup runs"
          density="compact"
          loading={loading}
          error={null}
          emptyState={<span>No database backups yet</span>}
          rowActions={rowActions}
          pagination={{
            // The DataTable is zero-based; the API is one-based.
            page: page - 1,
            pageSize,
            total,
            onPaginationChange: (next) => {
              if (next.pageSize !== pageSize) setPageSize(next.pageSize);
              else setPage(next.page + 1);
            },
          }}
          csvExport={{ filename: 'db-backup-runs' }}
        />
      </Box>

      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Permission-gated export
// ---------------------------------------------------------------------------

export default function DbBackupPage() {
  const { isAdmin, hasPermission } = usePermissions();

  if (!isAdmin || !hasPermission('db_backup:read')) {
    return <Navigate to="/" replace />;
  }

  return <DbBackupPageContent />;
}
