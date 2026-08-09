/**
 * Admin → Worker Nodes → Node Backup (`/admin/settings/nodes/:id/backup`).
 *
 * Issue #319 (epic #308): per-node backup status + config editor + run history
 * over the #312 node backup control plane:
 *
 *   - Status card — enabled state, checkpoint age, pending lag, acked totals,
 *     last run / completed / reconcile timestamps, active-run indicator.
 *   - Config card — enable toggle, schedule presets (daily / weekly / custom
 *     cron with the server's 400 surfaced inline), IANA timezone, circle
 *     include-list ("All my circles" when empty). Save = PUT; the returned
 *     `nextRunAt` renders immediately from the PUT response.
 *   - Runs table — shared DataTable over GET …/backup/runs?limit=20, rendered
 *     UNCONDITIONALLY with `loading` (docs/specs/datatable.md §18.4) since
 *     `useNodeBackup` silently polls every 15s.
 *
 * The download throttle is deliberately NOT editable here — it is a node-side
 * setting (`memoriahub backup set-rate`).
 *
 * Byte fields in every backup DTO are BigInt-safe STRINGS; they are humanized
 * via `formatBytes` (BigInt parsing), never `Number()` on the raw string.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Link as RouterLink, useParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Container,
  FormControl,
  FormControlLabel,
  InputLabel,
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
  SettingsBackupRestore as BackupIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useNodeBackup } from '../../hooks/useNodeBackup';
import { useCircles } from '../../hooks/useCircles';
import type { NodeBackupRunDto } from '../../services/nodeBackup';
import { DataTable } from '../../components/datatable';
import {
  NODE_BACKUP_RUNS_TABLE_ID,
  buildNodeBackupRunColumns,
} from './nodeBackupTable';
import { formatBytes, relativeTime } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Schedule presets
// ---------------------------------------------------------------------------

export const DAILY_CRON = '0 3 * * *';
export const WEEKLY_CRON = '0 3 * * 0';

type SchedulePreset = 'none' | 'daily' | 'weekly' | 'custom';

/** Map a stored cron back onto the preset select. */
export function deriveSchedulePreset(scheduleCron: string | null): SchedulePreset {
  if (scheduleCron === null || scheduleCron === '') return 'none';
  if (scheduleCron === DAILY_CRON) return 'daily';
  if (scheduleCron === WEEKLY_CRON) return 'weekly';
  return 'custom';
}

/**
 * IANA timezone options from `Intl.supportedValuesOf('timeZone')`.
 *
 * Typed via a narrow cast because the app's tsconfig lib is ES2020 while
 * `supportedValuesOf` is ES2022 — every supported runtime has it, but a
 * fallback keeps the select usable if an ancient browser doesn't.
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

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

function StatItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 160 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Box>
  );
}

function timestampOrNever(iso: string | null): string {
  return iso ? `${relativeTime(iso)} (${new Date(iso).toLocaleString()})` : 'never';
}

// ---------------------------------------------------------------------------
// Main content (admin-gated wrapper below)
// ---------------------------------------------------------------------------

function NodeBackupPageContent({ nodeId }: { nodeId: string }) {
  const { config, configLoaded, runs, loading, saving, error, refresh, saveConfig } =
    useNodeBackup(nodeId, { autoRefresh: true });
  const { circles, fetchCircles } = useCircles();

  // --- Form state ------------------------------------------------------------
  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );
  const timezoneOptions = useMemo<string[]>(
    () => supportedTimezones(browserTz),
    [browserTz],
  );

  const [enabled, setEnabled] = useState(true);
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('none');
  const [customCron, setCustomCron] = useState('');
  const [timezone, setTimezone] = useState<string>(browserTz);
  const [circleIds, setCircleIds] = useState<string[]>([]);

  const [cronError, setCronError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetchCircles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize the form ONCE from the first loaded config — the 15s poll keeps
  // refreshing the status card, but must never clobber an in-progress edit.
  const formInitialized = useRef(false);
  useEffect(() => {
    if (!configLoaded || formInitialized.current) return;
    formInitialized.current = true;
    if (config) {
      setEnabled(config.enabled);
      const preset = deriveSchedulePreset(config.scheduleCron);
      setSchedulePreset(preset);
      setCustomCron(preset === 'custom' ? (config.scheduleCron ?? '') : '');
      setTimezone(config.timezone ?? browserTz);
      setCircleIds(config.circleIds);
    }
  }, [configLoaded, config, browserTz]);

  // --- Save ------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setCronError(null);
    setFormError(null);

    let scheduleCron: string | null;
    switch (schedulePreset) {
      case 'none':
        scheduleCron = null;
        break;
      case 'daily':
        scheduleCron = DAILY_CRON;
        break;
      case 'weekly':
        scheduleCron = WEEKLY_CRON;
        break;
      case 'custom':
        scheduleCron = customCron.trim();
        if (!scheduleCron) {
          setCronError('Enter a 5-field cron expression');
          return;
        }
        break;
    }

    try {
      await saveConfig({
        enabled,
        scheduleCron,
        timezone: timezone || null,
        circleIds,
      });
      setSuccessMessage('Backup settings saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save backup settings';
      // Surface an invalid-cron 400 inline on the cron field; everything else
      // lands in the form-level alert.
      if (/cron/i.test(message)) {
        setCronError(message);
        setSchedulePreset('custom');
      } else {
        setFormError(message);
      }
    }
  }, [schedulePreset, customCron, enabled, timezone, circleIds, saveConfig]);

  // --- Circle multi-select value ---------------------------------------------

  type CircleOption = { id: string; name: string };
  const circleOptions = useMemo<CircleOption[]>(
    () => circles.map((c) => ({ id: c.id, name: c.name })),
    [circles],
  );
  const selectedCircles = useMemo<CircleOption[]>(
    () =>
      circleIds.map(
        (id) => circleOptions.find((c) => c.id === id) ?? { id, name: id },
      ),
    [circleIds, circleOptions],
  );

  // --- Runs table ------------------------------------------------------------

  const runColumns = useMemo(() => buildNodeBackupRunColumns(), []);

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Back link */}
        <Link
          component={RouterLink}
          to="/admin/settings/nodes"
          underline="hover"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; Back to Worker Nodes
        </Link>

        {/* Page header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <BackupIcon color="primary" />
          <Typography variant="h4" component="h1">
            Node Backup
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Local backup of this node&apos;s circles — schedule, scope, checkpoint
          progress, and run history. Node <code>{nodeId}</code>.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Status card                                                         */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
              Status
            </Typography>
            {config && (
              <Chip
                label={config.enabled ? 'Enabled' : 'Disabled'}
                color={config.enabled ? 'success' : 'default'}
                size="small"
                variant="outlined"
              />
            )}
            {config?.activeRunId && (
              <Chip label="Run in progress" color="info" size="small" />
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
          </Box>

          {!configLoaded ? (
            <Typography color="text.secondary" variant="body2">
              Loading backup status…
            </Typography>
          ) : !config ? (
            <Alert severity="info">
              Backup has never been configured for this node. Choose a schedule
              and scope below, then save to enable it.
            </Alert>
          ) : (
            <Stack
              direction="row"
              spacing={4}
              useFlexGap
              sx={{ flexWrap: 'wrap', rowGap: 2 }}
            >
              <StatItem label="Checkpoint">
                {config.checkpoint
                  ? relativeTime(config.checkpoint.updatedAt)
                  : 'no checkpoint yet'}
              </StatItem>
              <StatItem label="Pending">
                {config.pending.items} items · {formatBytes(config.pending.bytes)}
              </StatItem>
              <StatItem label="Acked total">
                {config.itemsAcked} items · {formatBytes(config.bytesAcked)}
              </StatItem>
              <StatItem label="Last run">{timestampOrNever(config.lastRunAt)}</StatItem>
              <StatItem label="Last completed">
                {timestampOrNever(config.lastCompletedRunAt)}
              </StatItem>
              <StatItem label="Last reconcile">
                {timestampOrNever(config.lastReconcileAt)}
              </StatItem>
            </Stack>
          )}
        </Paper>

        {/* ------------------------------------------------------------------ */}
        {/* Config card                                                         */}
        {/* ------------------------------------------------------------------ */}
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Configuration
          </Typography>
          <Alert severity="info" sx={{ mb: 2 }}>
            Runs start when the node&apos;s daemon polls in — an offline node runs
            when it reconnects.
          </Alert>

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
                  disabled={saving}
                />
              }
              label="Backup enabled"
            />

            <FormControl fullWidth>
              <InputLabel id="backup-schedule-label">Schedule</InputLabel>
              <Select
                labelId="backup-schedule-label"
                label="Schedule"
                value={schedulePreset}
                disabled={saving}
                onChange={(e) => {
                  setSchedulePreset(e.target.value as SchedulePreset);
                  setCronError(null);
                }}
              >
                <MenuItem value="none">No schedule (manual only)</MenuItem>
                <MenuItem value="daily">Daily 03:00</MenuItem>
                <MenuItem value="weekly">Weekly Sun 03:00</MenuItem>
                <MenuItem value="custom">Custom cron…</MenuItem>
              </Select>
            </FormControl>

            {schedulePreset === 'custom' && (
              <TextField
                label="Cron expression"
                value={customCron}
                onChange={(e) => {
                  setCustomCron(e.target.value);
                  setCronError(null);
                }}
                disabled={saving}
                error={!!cronError}
                helperText={
                  cronError ??
                  'A 5-field cron expression: minute hour day-of-month month day-of-week'
                }
                placeholder="0 3 * * *"
                fullWidth
              />
            )}
            {schedulePreset !== 'custom' && cronError && (
              <Alert severity="error">{cronError}</Alert>
            )}

            <Autocomplete
              options={timezoneOptions}
              value={timezone}
              onChange={(_e, next) => setTimezone(next ?? browserTz)}
              disabled={saving}
              disableClearable={false}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Timezone"
                  helperText="IANA timezone the schedule is evaluated in"
                />
              )}
            />

            <Autocomplete<CircleOption, true>
              multiple
              options={circleOptions}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              value={selectedCircles}
              onChange={(_e, next) => setCircleIds(next.map((c) => c.id))}
              disabled={saving}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Circles"
                  placeholder={circleIds.length === 0 ? 'All my circles' : undefined}
                  helperText="Leave empty to back up all my circles"
                />
              )}
            />

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button
                variant="contained"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Typography variant="body2" color="text.secondary">
                {config?.nextRunAt
                  ? `Next run: ${new Date(config.nextRunAt).toLocaleString()}`
                  : 'Next run: not scheduled'}
              </Typography>
            </Box>

            <Typography variant="caption" color="text.secondary">
              Download throttle is not editable here — set it on the node with{' '}
              <code>memoriahub backup set-rate</code>.
            </Typography>
          </Stack>
        </Paper>

        {/* ------------------------------------------------------------------ */}
        {/* Runs table                                                          */}
        {/* ------------------------------------------------------------------ */}
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
          Recent runs
        </Typography>
        <DataTable<NodeBackupRunDto>
          columns={runColumns}
          rows={runs}
          rowId={(run) => run.id}
          tableId={NODE_BACKUP_RUNS_TABLE_ID}
          ariaLabel="Backup runs"
          density="compact"
          loading={loading}
          error={null}
          emptyState={<span>No backup runs yet</span>}
          csvExport={{ filename: 'node-backup-runs' }}
        />
      </Box>

      {/* Success snackbar */}
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
// Admin-gated export (mirrors WorkersPage pattern)
// ---------------------------------------------------------------------------

export default function NodeBackupPage() {
  const { isAdmin } = usePermissions();
  const { id } = useParams<{ id: string }>();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  if (!id) {
    return <Navigate to="/admin/settings/nodes" replace />;
  }

  return <NodeBackupPageContent nodeId={id} />;
}
