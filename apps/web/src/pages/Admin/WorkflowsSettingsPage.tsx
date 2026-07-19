import { useState, useEffect, useCallback } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  Switch,
  FormControlLabel,
  CircularProgress,
  Alert,
  Snackbar,
  Link,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import { AccountTree as AccountTreeIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import type { SystemSettings } from '../../types';
import { WorkflowsDangerCard } from '../../components/workflows/admin/WorkflowsDangerCard';
import { WorkflowsKpiStrip } from '../../components/workflows/admin/WorkflowsKpiStrip';
import { WorkflowsOversightTable } from '../../components/workflows/admin/WorkflowsOversightTable';
import { WorkflowRunsDrawer } from '../../components/workflows/admin/WorkflowRunsDrawer';
import {
  getAdminWorkflowStats,
  listAdminWorkflows,
  listAdminWorkflowRuns,
  disableAdminWorkflow,
  cancelAdminWorkflowRun,
  type AdminWorkflowStats,
  type AdminWorkflowListItem,
  type AdminWorkflowRun,
} from '../../services/adminWorkflows';

// ---------------------------------------------------------------------------
// Media Workflow Automation — admin settings & oversight (issue #143).
//
// Sub-page of the Settings hub (Operations group). Feature/trigger toggles and
// engine limits (PATCH /api/system-settings), a hard-delete danger card, a KPI
// strip, and a cross-circle oversight table with disable / view-runs / cancel
// row actions.
// ---------------------------------------------------------------------------

/** Defaults mirror the Phase 1 `workflows.*` Zod schema (issue #143 table). */
const DEFAULTS = {
  maxItemsPerRun: 10000,
  batchSize: 200,
  maxConcurrentRuns: 2,
  maxWorkflowsPerCircle: 20,
  previewTtlHours: 24,
  runHistoryRetentionDays: 30,
  scheduleMinIntervalMinutes: 60,
  requirePreview: true,
  allowHardDelete: false,
  onEnrichment: true,
  scheduled: true,
};

function WorkflowsSettingsContent() {
  const { settings, isSaving, updateSettings, error } = useSystemSettings();
  const { hasPermission } = usePermissions();

  const canManage = hasPermission('system_settings:write');
  const canCancel = hasPermission('jobs:write');

  // Numeric limit fields (edited locally, saved via the "Save limits" button)
  const [maxItemsPerRun, setMaxItemsPerRun] = useState('');
  const [batchSize, setBatchSize] = useState('');
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState('');
  const [maxWorkflowsPerCircle, setMaxWorkflowsPerCircle] = useState('');
  const [previewTtlHours, setPreviewTtlHours] = useState('');
  const [runHistoryRetentionDays, setRunHistoryRetentionDays] = useState('');
  const [scheduleMinIntervalMinutes, setScheduleMinIntervalMinutes] = useState('');
  const [limitsSaving, setLimitsSaving] = useState(false);

  // Feedback
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Oversight data
  const [stats, setStats] = useState<AdminWorkflowStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [workflows, setWorkflows] = useState<AdminWorkflowListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(0); // zero-based (MUI)
  const [pageSize, setPageSize] = useState(25);

  // Disable confirm
  const [disableTarget, setDisableTarget] = useState<AdminWorkflowListItem | null>(null);
  const [disabling, setDisabling] = useState(false);

  // Runs drawer
  const [runsWorkflow, setRunsWorkflow] = useState<AdminWorkflowListItem | null>(null);
  const [runs, setRuns] = useState<AdminWorkflowRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AdminWorkflowRun | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);

  const wf = settings?.workflows;

  useEffect(() => {
    if (!settings) return;
    setMaxItemsPerRun(String(wf?.maxItemsPerRun ?? DEFAULTS.maxItemsPerRun));
    setBatchSize(String(wf?.batchSize ?? DEFAULTS.batchSize));
    setMaxConcurrentRuns(String(wf?.maxConcurrentRuns ?? DEFAULTS.maxConcurrentRuns));
    setMaxWorkflowsPerCircle(
      String(wf?.maxWorkflowsPerCircle ?? DEFAULTS.maxWorkflowsPerCircle),
    );
    setPreviewTtlHours(String(wf?.previewTtlHours ?? DEFAULTS.previewTtlHours));
    setRunHistoryRetentionDays(
      String(wf?.runHistoryRetentionDays ?? DEFAULTS.runHistoryRetentionDays),
    );
    setScheduleMinIntervalMinutes(
      String(wf?.scheduleMinIntervalMinutes ?? DEFAULTS.scheduleMinIntervalMinutes),
    );
  }, [settings, wf]);

  // -------------------------------------------------------------------------
  // Oversight fetching
  // -------------------------------------------------------------------------

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await getAdminWorkflowStats());
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchWorkflows = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await listAdminWorkflows({ page: page + 1, pageSize });
      setWorkflows(res.items);
      setTotalItems(res.meta.totalItems);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Failed to load workflows',
      );
    } finally {
      setListLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    void fetchWorkflows();
  }, [fetchWorkflows]);

  const fetchRuns = useCallback(async (workflowId: string) => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await listAdminWorkflowRuns({ workflowId, pageSize: 25 });
      setRuns(res.items);
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'Failed to load runs');
    } finally {
      setRunsLoading(false);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Settings save helpers
  // -------------------------------------------------------------------------

  const patch = (updates: Partial<SystemSettings>, successText?: string) =>
    updateSettings(updates)
      .then(() => {
        if (successText) setSuccessMessage(successText);
      })
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
      });

  const handleFeatureToggle = (checked: boolean) => {
    void patch({ features: { ...(settings?.features ?? {}), workflows: checked } });
  };

  const handleTriggerToggle = (
    key: 'onEnrichment' | 'scheduled',
    checked: boolean,
  ) => {
    void patch({ workflows: { triggers: { [key]: checked } } });
  };

  const handleRequirePreviewToggle = (checked: boolean) => {
    void patch({ workflows: { requirePreview: checked } });
  };

  const handleAllowHardDeleteToggle = (checked: boolean) => {
    void patch(
      { workflows: { allowHardDelete: checked } },
      checked ? 'Hard delete unlocked' : 'Hard delete locked',
    );
  };

  const handleSaveLimits = () => {
    setLimitsSaving(true);
    updateSettings({
      workflows: {
        maxItemsPerRun: Number(maxItemsPerRun),
        batchSize: Number(batchSize),
        maxConcurrentRuns: Number(maxConcurrentRuns),
        maxWorkflowsPerCircle: Number(maxWorkflowsPerCircle),
        previewTtlHours: Number(previewTtlHours),
        runHistoryRetentionDays: Number(runHistoryRetentionDays),
        scheduleMinIntervalMinutes: Number(scheduleMinIntervalMinutes),
      },
    })
      .then(() => setSuccessMessage('Workflow limits saved'))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to save limits');
      })
      .finally(() => setLimitsSaving(false));
  };

  // -------------------------------------------------------------------------
  // Row action handlers
  // -------------------------------------------------------------------------

  const handleViewRuns = (item: AdminWorkflowListItem) => {
    setRunsWorkflow(item);
    setRuns([]);
    void fetchRuns(item.id);
  };

  const handleConfirmDisable = () => {
    if (!disableTarget) return;
    setDisabling(true);
    disableAdminWorkflow(disableTarget.id)
      .then(() => {
        setSuccessMessage(`Disabled "${disableTarget.name}"`);
        setDisableTarget(null);
        void fetchWorkflows();
        void fetchStats();
      })
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to disable workflow');
      })
      .finally(() => setDisabling(false));
  };

  const handleConfirmCancel = () => {
    if (!cancelTarget) return;
    const runId = cancelTarget.id;
    setCancellingRunId(runId);
    cancelAdminWorkflowRun(runId)
      .then(() => {
        setSuccessMessage('Run cancelled');
        setCancelTarget(null);
        if (runsWorkflow) void fetchRuns(runsWorkflow.id);
        void fetchWorkflows();
        void fetchStats();
      })
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Failed to cancel run');
      })
      .finally(() => setCancellingRunId(null));
  };

  if (!settings && !error) {
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

  const featureEnabled = settings?.features?.workflows ?? false;

  return (
    <Container maxWidth="lg">
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
          <AccountTreeIcon color="primary" />
          <Typography variant="h4" component="h1">
            Workflow Automation
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Control the blast radius, throughput, and safety of automated media
          workflows across every circle.
        </Typography>

        {/* KPI strip */}
        <Box sx={{ mb: 3 }}>
          <WorkflowsKpiStrip stats={stats} loading={statsLoading} />
        </Box>

        {/* Global feature toggle */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Global Settings
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={featureEnabled}
                onChange={(e) => handleFeatureToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Enable workflow automation globally"
            sx={{ mb: 1, display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary">
            Master on/off switch. When off, no workflow can be created, previewed, or
            run — regardless of the trigger switches below. The
            <code> WORKFLOWS_ENABLED=false</code> environment variable overrides this.
          </Typography>
        </Paper>

        {/* Triggers & approval */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Triggers &amp; Approval
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={wf?.triggers?.onEnrichment ?? DEFAULTS.onEnrichment}
                onChange={(e) => handleTriggerToggle('onEnrichment', e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="On new media (post-enrichment trigger)"
            sx={{ display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, ml: 6 }}>
            Master switch for workflows that fire automatically once newly-uploaded
            media finishes enrichment.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={wf?.triggers?.scheduled ?? DEFAULTS.scheduled}
                onChange={(e) => handleTriggerToggle('scheduled', e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Scheduled runs (cron trigger)"
            sx={{ display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, ml: 6 }}>
            Master switch for scheduled workflow runs. When off, cron-triggered
            workflows never start even if individually enabled.
          </Typography>

          <Divider sx={{ my: 2 }} />

          <FormControlLabel
            control={
              <Switch
                checked={wf?.requirePreview ?? DEFAULTS.requirePreview}
                onChange={(e) => handleRequirePreviewToggle(e.target.checked)}
                disabled={isSaving || !settings}
              />
            }
            label="Require preview approval for manual runs"
            sx={{ display: 'block' }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ ml: 6 }}>
            When on, every manual run must pass an approval preview before it executes;
            a per-workflow opt-out is only honored while this is off. Unattended
            (triggered/scheduled) runs are unaffected.
          </Typography>
        </Paper>

        {/* Engine limits */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Engine Limits
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="Max items per run"
              type="number"
              size="small"
              value={maxItemsPerRun}
              onChange={(e) => setMaxItemsPerRun(e.target.value)}
              helperText="Hard cap on items a single run can touch; runs matching more are truncated. 100–500,000."
              slotProps={{ htmlInput: { min: 100, max: 500000 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Batch size"
              type="number"
              size="small"
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              helperText="Items per execution-batch job; keep well under the stuck-job runtime threshold. 50–1,000."
              slotProps={{ htmlInput: { min: 50, max: 1000 } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="Max concurrent runs"
              type="number"
              size="small"
              value={maxConcurrentRuns}
              onChange={(e) => setMaxConcurrentRuns(e.target.value)}
              helperText="App-wide simultaneous non-terminal runs; extra manual runs are rejected (409), scheduler starts are skipped. 1–10."
              slotProps={{ htmlInput: { min: 1, max: 10 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Max workflows per circle"
              type="number"
              size="small"
              value={maxWorkflowsPerCircle}
              onChange={(e) => setMaxWorkflowsPerCircle(e.target.value)}
              helperText="Maximum number of workflows a single circle can define. 1–100."
              slotProps={{ htmlInput: { min: 1, max: 100 } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              label="Preview TTL (hours)"
              type="number"
              size="small"
              value={previewTtlHours}
              onChange={(e) => setPreviewTtlHours(e.target.value)}
              helperText="Runs awaiting approval expire after this many hours. 1–168."
              slotProps={{ htmlInput: { min: 1, max: 168 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Run history retention (days)"
              type="number"
              size="small"
              value={runHistoryRetentionDays}
              onChange={(e) => setRunHistoryRetentionDays(e.target.value)}
              helperText="How long terminal runs and their items are kept before purge. 1–365."
              slotProps={{ htmlInput: { min: 1, max: 365 } }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Min schedule interval (minutes)"
              type="number"
              size="small"
              value={scheduleMinIntervalMinutes}
              onChange={(e) => setScheduleMinIntervalMinutes(e.target.value)}
              helperText="Tightest cron cadence a scheduled workflow may use. 60–10,080."
              slotProps={{ htmlInput: { min: 60, max: 10080 } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <Button
            variant="contained"
            disabled={isSaving || limitsSaving || !settings}
            startIcon={limitsSaving ? <CircularProgress size={16} /> : undefined}
            onClick={handleSaveLimits}
          >
            Save Limits
          </Button>
        </Paper>

        {/* Danger card */}
        <Box sx={{ mb: 3 }}>
          <WorkflowsDangerCard
            allowHardDelete={wf?.allowHardDelete ?? DEFAULTS.allowHardDelete}
            saving={isSaving}
            ready={!!settings}
            onToggle={handleAllowHardDeleteToggle}
          />
        </Box>

        {/* Oversight table */}
        <WorkflowsOversightTable
          items={workflows}
          loading={listLoading}
          totalItems={totalItems}
          page={page}
          pageSize={pageSize}
          canManage={canManage}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(0);
          }}
          onDisable={setDisableTarget}
          onViewRuns={handleViewRuns}
        />
      </Box>

      {/* Runs drawer */}
      <WorkflowRunsDrawer
        open={!!runsWorkflow}
        workflowName={runsWorkflow?.name ?? null}
        runs={runs}
        loading={runsLoading}
        error={runsError}
        canCancel={canCancel}
        cancellingRunId={cancellingRunId}
        onCancel={setCancelTarget}
        onClose={() => setRunsWorkflow(null)}
      />

      {/* Disable confirm */}
      <Dialog open={!!disableTarget} onClose={() => (disabling ? undefined : setDisableTarget(null))}>
        <DialogTitle>Disable workflow?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Force-disable &quot;{disableTarget?.name}&quot; in{' '}
            {disableTarget?.circle?.name ?? 'its circle'}? It will stop triggering and
            can be re-enabled by a circle admin. This does not delete the workflow or
            any media.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisableTarget(null)} disabled={disabling}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleConfirmDisable}
            disabled={disabling}
            startIcon={disabling ? <CircularProgress size={16} /> : undefined}
          >
            Disable
          </Button>
        </DialogActions>
      </Dialog>

      {/* Cancel-run confirm */}
      <Dialog open={!!cancelTarget} onClose={() => (cancellingRunId ? undefined : setCancelTarget(null))}>
        <DialogTitle>Cancel this run?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Cancel the in-progress run for &quot;{runsWorkflow?.name}&quot;? Items already
            actioned are not reverted, but no further items will be processed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelTarget(null)} disabled={!!cancellingRunId}>
            Keep running
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleConfirmCancel}
            disabled={!!cancellingRunId}
            startIcon={cancellingRunId ? <CircularProgress size={16} /> : undefined}
          >
            Cancel run
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!successMessage}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      <Snackbar open={!!localError} autoHideDuration={5000} onClose={() => setLocalError(null)}>
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default function WorkflowsSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <WorkflowsSettingsContent />;
}
