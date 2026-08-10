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
 *   - Restore (#344) — the Restore row action opens `DbBackupRestoreDialog`,
 *     and this page owns the three surfaces that outlive that dialog: the
 *     always-visible runbook link, the two-phase restore progress, and the
 *     post-restore rollback affordance with its expiry.
 *
 * ## Why restore progress is two phases and not one bar
 *
 * Phase 1 rebuilds into a scratch database for hours with the app fully ONLINE
 * and heartbeating. Phase 2 renames the database and exits the process: seconds
 * long, and the app IS briefly down. A single undifferentiated bar would
 * misrepresent both — it would imply the app is down for hours, and it would
 * give no warning before the one moment that actually interrupts service.
 *
 * During phase 2 the poll is EXPECTED to fail (the API deliberately exits), so
 * the hook reports `restarting` and this page renders that as a restart in
 * progress rather than an error.
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
import DbBackupRestoreDialog, {
  RunbookLink,
  restoreBlockedReason,
} from './DbBackupRestoreDialog';
import { RESTORE_ACTIVE_STATUSES } from '../../services/dbBackup';
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

/**
 * The most recent run whose restore COMPLETED — i.e. the one a rollback would
 * undo.
 *
 * Rollback is the single reason this restore design is safe to attempt at all,
 * so it has to be visible on the page rather than buried behind a row's
 * overflow menu. Only one restore can ever be the current state of the
 * database, so "most recent completed" is not a heuristic — it is the answer.
 */
export function findRollbackTarget(runs: DbBackupRunDto[]): DbBackupRunDto | null {
  const candidates = runs.filter(
    (r) => r.restoreStatus === 'completed' && (r.restoreOldDb || r.preRestoreBackupId),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) =>
    new Date(r.restoredAt ?? r.swappedAt ?? 0).getTime() >
    new Date(best.restoredAt ?? best.swappedAt ?? 0).getTime()
      ? r
      : best,
  );
}

/**
 * When the retained pre-swap database is dropped, after which a rollback stops
 * being a seconds-long rename and becomes another multi-hour restore.
 *
 * Null in `pre_restore_dump` mode: there is no retained database to expire, and
 * showing a countdown there would imply a fast path that does not exist.
 */
export function rollbackExpiry(
  run: DbBackupRunDto,
  retentionHours: number,
): Date | null {
  if (!run.restoreOldDb || !run.swappedAt) return null;
  return new Date(new Date(run.swappedAt).getTime() + retentionHours * 3_600_000);
}

/**
 * Which of the two restore phases a status belongs to.
 *
 * `restoring`/`verifying` are the long, online phase; `swapping` is the brief
 * offline cutover. The split is the whole reason this is not one progress bar.
 */
export function restorePhase(
  status: string | null,
): 'rebuilding' | 'swapping' | null {
  if (status === 'restoring' || status === 'verifying') return 'rebuilding';
  if (status === 'swapping') return 'swapping';
  return null;
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
    restoringRun,
    restorePollState,
    startRestore,
    rollbackRestore,
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

  // --- Restore ---------------------------------------------------------------
  const [restoreTarget, setRestoreTarget] = useState<DbBackupRunDto | null>(null);

  const restoreInFlight =
    !!restoringRun?.restoreStatus &&
    RESTORE_ACTIVE_STATUSES.includes(restoringRun.restoreStatus);

  const rollbackTarget = useMemo(() => findRollbackTarget(runs), [runs]);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);

  const handleRollback = useCallback(
    async (run: DbBackupRunDto) => {
      setActionError(null);
      setRollbackBusy(true);
      try {
        const result = await rollbackRestore(run.id);
        if (result.mode === 'renamed') {
          setRollbackNotice(
            `Rolled back to ${result.restoredDatabase}. The app is restarting — this page will reconnect on its own.`,
          );
        } else if (result.mode === 'restore_started') {
          setRollbackNotice(
            'No retained database exists in this mode, so a full restore of the pre-restore backup was started instead. This takes hours; progress is shown above.',
          );
        } else {
          setActionError(result.reason);
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Rollback failed');
      } finally {
        setRollbackBusy(false);
      }
    },
    [rollbackRestore],
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
        // `DataTableRowAction.label` is a plain string, not a per-row function,
        // so the label carries the two REASONS that are page-level (permission,
        // exclusivity) and names the per-row gate for the rest. A disabled
        // control that doesn't say why sends an admin hunting through docs.
        label: !canRestore
          ? 'Restore — requires the db_backup:restore permission'
          : restoreInFlight
            ? 'Restore — unavailable: another restore is already in progress'
            : 'Restore — completed backups only',
        icon: <RestoreIcon fontSize="small" />,
        // Gated on `db_backup:restore`, which is deliberately separate from
        // `db_backup:write`: scheduling a backup is routine, whereas this
        // renames the live database and restarts the process.
        disabled: (run) =>
          restoreBlockedReason(run, { canRestore, restoreInFlight }) !== null,
        onClick: (run) => setRestoreTarget(run),
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
    [canWrite, canRestore, restoreInFlight, handleDownload, handleDelete],
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
        {/* Restore & rollback                                                  */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }} id="db-backup-restore">
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Restore
          </Typography>

          {/* Prominent, unconditionally — the scenario this document exists for
              is the one where this page cannot be reached, so it has to have
              been seen before then. */}
          <RunbookLink sx={{ mb: 2 }} />

          {restoreInFlight && restoringRun ? (
            (() => {
              const phase = restorePhase(restoringRun.restoreStatus);
              const swapping =
                phase === 'swapping' || restorePollState === 'restarting';
              return (
                <Box data-testid="restore-progress">
                  {/* Phase 1 — long, and the app is UP. */}
                  <Box sx={{ mb: 2 }}>
                    <Box
                      sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}
                    >
                      <Chip
                        size="small"
                        label="1"
                        color={swapping ? 'success' : 'info'}
                      />
                      <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                        Restoring into the scratch database
                        {restoringRun.restoreScratchDb
                          ? ` (${restoringRun.restoreScratchDb})`
                          : ''}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        color="success"
                        label="app online"
                      />
                    </Box>
                    <LinearProgress
                      variant={swapping ? 'determinate' : 'indeterminate'}
                      value={swapping ? 100 : undefined}
                      color={swapping ? 'success' : 'primary'}
                    />
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 0.5 }}
                    >
                      {swapping
                        ? 'Rebuild finished.'
                        : `Every vector index is rebuilt from scratch, so this phase runs for hours. MemoriaHub keeps serving from the current database throughout, and cancelling now changes nothing — your live data has not been touched yet.${
                            restoringRun.restoreStatus === 'verifying'
                              ? ' Currently verifying the restored copy.'
                              : ''
                          }`}
                    </Typography>
                  </Box>

                  {/* Phase 2 — seconds, and the app is DOWN. */}
                  <Box>
                    <Box
                      sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}
                    >
                      <Chip
                        size="small"
                        label="2"
                        color={swapping ? 'warning' : 'default'}
                      />
                      <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                        Swapping databases and restarting
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={swapping ? 'warning' : 'default'}
                        label="app offline briefly"
                      />
                    </Box>
                    {swapping && <LinearProgress color="warning" />}
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 0.5 }}
                    >
                      {swapping
                        ? 'Two database renames and a process restart — seconds, not hours.'
                        : 'Has not started yet.'}
                    </Typography>
                  </Box>

                  {/*
                    The API renames the live database and calls `process.exit(0)`
                    here, so the poll MUST fail for the length of the restart.
                    Rendering that as an error would report a failure at the
                    precise moment the restore is succeeding.
                  */}
                  {restorePollState === 'restarting' && (
                    <Alert severity="info" sx={{ mt: 2 }} data-testid="restore-restarting">
                      <AlertTitle>Restarting…</AlertTitle>
                      The server is swapping the database and restarting. It is
                      expected to be unreachable for a few seconds — this is not
                      an error. This page keeps checking and will reconnect on
                      its own.
                    </Alert>
                  )}

                  {restoringRun.restoreError && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                      {restoringRun.restoreError}
                    </Alert>
                  )}
                </Box>
              );
            })()
          ) : (
            <Typography variant="body2" color="text.secondary">
              No restore is in progress. Start one from the Restore action on a
              completed backup below.
            </Typography>
          )}

          {/* The rollback affordance is the main reason this design is safe to
              use, so it lives here rather than inside a row menu. */}
          {rollbackTarget && !restoreInFlight && (
            <Box sx={{ mt: 2 }} data-testid="rollback-surface">
              <Divider sx={{ mb: 2 }} />
              <Alert
                severity="success"
                action={
                  <Button
                    size="small"
                    color="warning"
                    variant="outlined"
                    disabled={!canRestore || rollbackBusy}
                    onClick={() => void handleRollback(rollbackTarget)}
                  >
                    {rollbackBusy ? 'Rolling back…' : 'Roll back'}
                  </Button>
                }
              >
                <AlertTitle>
                  Restored from backup {rollbackTarget.id.slice(0, 8)}
                  {rollbackTarget.restoredAt
                    ? ` on ${new Date(rollbackTarget.restoredAt).toLocaleString()}`
                    : ''}
                </AlertTitle>
                {rollbackTarget.restoreOldDb ? (
                  <>
                    Your previous database is retained as{' '}
                    <code>{rollbackTarget.restoreOldDb}</code>. Rolling back is a
                    rename plus a restart — <strong>seconds</strong>.
                    {(() => {
                      const expiry = rollbackExpiry(
                        rollbackTarget,
                        config?.oldDatabaseRetentionHours ?? 168,
                      );
                      return expiry ? (
                        <>
                          {' '}
                          It is dropped at{' '}
                          <strong>{expiry.toLocaleString()}</strong>, after which
                          rolling back means a full multi-hour restore.
                        </>
                      ) : null;
                    })()}
                  </>
                ) : (
                  <>
                    No database was retained in this mode. A pre-restore backup
                    was taken instead, so rolling back runs a full restore —{' '}
                    <strong>hours</strong>, not seconds.
                  </>
                )}
              </Alert>
              {rollbackNotice && (
                <Alert
                  severity="info"
                  sx={{ mt: 1 }}
                  onClose={() => setRollbackNotice(null)}
                >
                  {rollbackNotice}
                </Alert>
              )}
            </Box>
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

      <DbBackupRestoreDialog
        open={!!restoreTarget}
        run={restoreTarget}
        config={config}
        restoreInFlight={restoreInFlight}
        onClose={() => setRestoreTarget(null)}
        onStart={startRestore}
      />

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
