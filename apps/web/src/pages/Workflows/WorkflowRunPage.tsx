/**
 * Workflow run detail — approval preview, live progress, and failed items.
 *
 * Issue #261 (epic #238) replaced the hand-rolled failed-items
 * `<TableContainer>` + `<Pagination>` block with the shared DataTable
 * (`components/runs/runItemsTable.tsx`). Two rules matter on a page that polls
 * its run every 2s: the table is rendered UNCONDITIONALLY with `loading` as a
 * prop, and the effect/memos around it key on SCALARS rather than on the `run`
 * object the poll replaces each tick. See docs/specs/datatable.md §13.2 / §18.4.
 *
 * The `awaiting_approval` exclusion GRID is deliberately untouched: it is a
 * thumbnail picker with per-tile checkboxes, not a data table, and it already
 * reflows through MUI's own `Grid` breakpoints.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box,
  Typography,
  Button,
  Chip,
  CircularProgress,
  Alert,
  AlertTitle,
  Grid,
  Card,
  CardContent,
  Checkbox,
  TextField,
  Snackbar,
  Pagination,
  Stack,
  List,
  ListItem,
  ListItemText,
  Tooltip,
} from '@mui/material';
import {
  BrokenImage as BrokenImageIcon,
  ArrowBack as ArrowBackIcon,
  Visibility as VisibilityIcon,
} from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkflowRun } from '../../hooks/useWorkflowRun';
import { useWorkflowRunItems } from '../../hooks/useWorkflowRunItems';
import { useWorkflowMutations } from '../../hooks/useWorkflowMutations';
import { useRunPolling } from '../../hooks/useRunPolling';
import RunProgressPanel from '../../components/runs/RunProgressPanel';
import type { RunTerminalSummary } from '../../components/runs/RunProgressPanel';
import {
  RUN_ITEMS_EMPTY_STATE,
  RUN_ITEMS_PAGE_SIZE,
  buildRunItemColumns,
} from '../../components/runs/runItemsTable';
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import {
  runStatusColor,
  runStatusLabel,
  formatRelativeTime,
  formatCount,
  formatCaptureDate,
  isTerminalRunStatus,
  deriveActionImpacts,
  definitionHasHardDelete,
  hardDeleteConfirmationText,
} from '../../utils/workflowFormat';
import type { WorkflowRunDetail, WorkflowRunItem } from '../../types/workflows';

const ITEMS_PAGE_SIZE = 24;
const MAX_EXCLUSIONS = 500;

/**
 * Persistence key for the failed-items table's column/density choices
 * (`user_settings.dataTables['workflow-run-items']`, docs/specs/datatable.md
 * §15). Chosen here and never derived from the route.
 */
export const WORKFLOW_RUN_ITEMS_TABLE_ID = 'workflow-run-items';

// ---------------------------------------------------------------------------
// Run item tile — thumbnail + filename + capture date, optional exclude checkbox
// ---------------------------------------------------------------------------

interface RunItemTileProps {
  item: WorkflowRunItem;
  excluded: boolean;
  checkboxDisabled: boolean;
  onToggle?: (mediaItemId: string, next: boolean) => void;
  showError?: boolean;
}

function RunItemTile({
  item,
  excluded,
  checkboxDisabled,
  onToggle,
  showError,
}: RunItemTileProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const filename = item.media?.filename ?? 'Untitled';
  const captureDate = formatCaptureDate(item.media?.capturedAt ?? null);

  return (
    <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1 / 1',
          bgcolor: 'action.hover',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          opacity: excluded ? 0.4 : 1,
        }}
      >
        {item.thumbnailUrl && !imgFailed ? (
          <Box
            component="img"
            src={item.thumbnailUrl}
            alt={filename}
            loading="lazy"
            onError={() => setImgFailed(true)}
            sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <BrokenImageIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
        )}
        {onToggle && (
          <Checkbox
            checked={excluded}
            disabled={checkboxDisabled}
            onChange={(e) => onToggle(item.mediaItemId, e.target.checked)}
            slotProps={{ input: { 'aria-label': `Exclude ${filename}` } }}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              bgcolor: 'background.paper',
              borderRadius: 1,
              p: 0.5,
              '&:hover': { bgcolor: 'background.paper' },
            }}
          />
        )}
      </Box>
      <CardContent sx={{ py: 1, px: 1.5, flexGrow: 1 }}>
        <Typography variant="body2" noWrap title={filename} sx={{ fontWeight: 500 }}>
          {filename}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {captureDate}
        </Typography>
        {showError && item.error && (
          <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
            {item.error}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/** Severity + message for a terminal run status. */
function terminalSummary(run: WorkflowRunDetail): RunTerminalSummary {
  switch (run.status) {
    case 'completed':
      return { severity: 'success', message: 'All actions applied successfully.' };
    case 'completed_with_errors':
      return {
        severity: 'warning',
        message: 'The run completed, but some items failed. Review them below.',
      };
    case 'failed':
      return { severity: 'error', message: run.lastError ?? 'The run failed.' };
    case 'cancelled':
      return { severity: 'info', message: 'This run was cancelled.' };
    case 'expired':
      return { severity: 'warning', message: 'This run expired before it was approved.' };
    default:
      return { severity: 'info', message: '' };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkflowRunPage() {
  const { id: workflowId, runId } = useParams<{ id: string; runId: string }>();
  const navigate = useNavigate();
  const { activeCircleRole } = useCircle();
  const { hasPermission } = usePermissions();

  const { run, isLoading, error, fetchRun } = useWorkflowRun();
  const {
    items,
    meta: itemsMeta,
    isLoading: itemsLoading,
    fetchItems,
  } = useWorkflowRunItems();
  const { approveRun, cancelRun, isSaving } = useWorkflowMutations();

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState('');
  const [itemsPage, setItemsPage] = useState(1);
  // The failed-items DataTable is server-paginated: `failedPage` is ZERO-based
  // (the component's convention) and converted at the fetch boundary.
  const [failedPage, setFailedPage] = useState(0);
  const [failedPageSize, setFailedPageSize] = useState(RUN_ITEMS_PAGE_SIZE);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Permission gates (mirror the list page: per-circle role + system permission).
  const canApprove =
    (activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin') &&
    hasPermission('media:write');
  const canHardDelete = canApprove && hasPermission('media:delete');

  const hasHardDelete = definitionHasHardDelete(run?.definitionSnapshot);

  // Initial load.
  useEffect(() => {
    if (runId) void fetchRun(runId);
  }, [runId, fetchRun]);

  // Live progress while the run is non-terminal.
  useRunPolling({ runId, status: run?.status, onPoll: fetchRun });

  // Load the matched-item grid while awaiting approval.
  useEffect(() => {
    if (!runId || run?.status !== 'awaiting_approval') return;
    void fetchItems(runId, {
      status: 'matched',
      page: itemsPage,
      pageSize: ITEMS_PAGE_SIZE,
    });
  }, [runId, run?.status, itemsPage, fetchItems]);

  // Load the failed-item table once the run is terminal and has failures.
  //
  // Keyed on the two SCALARS this depends on, never on `run` itself: the
  // run-detail poll hands back a fresh object every tick, and depending on that
  // identity would refetch the item page — and with it reset the table — twice
  // a second.
  const isTerminal = run ? isTerminalRunStatus(run.status) : false;
  const failedCount = run?.failedCount ?? 0;
  useEffect(() => {
    if (!runId || !isTerminal || failedCount <= 0) return;
    void fetchItems(runId, {
      status: 'failed',
      page: failedPage + 1, // the API is 1-based, the table 0-based
      pageSize: failedPageSize,
    });
  }, [runId, isTerminal, failedCount, failedPage, failedPageSize, fetchItems]);

  const effectiveMatched = useMemo(
    () => (run ? Math.max(0, run.matchedCount - excluded.size) : 0),
    [run, excluded.size],
  );

  const impacts = useMemo(
    () =>
      run
        ? deriveActionImpacts(
            run.definitionSnapshot?.actions,
            effectiveMatched,
            run.actionSummary?.byActionType,
          )
        : [],
    [run, effectiveMatched],
  );

  const handleToggleExclude = useCallback((mediaItemId: string, next: boolean) => {
    setExcluded((prev) => {
      const copy = new Set(prev);
      if (next) {
        if (copy.size >= MAX_EXCLUSIONS && !copy.has(mediaItemId)) return prev;
        copy.add(mediaItemId);
      } else {
        copy.delete(mediaItemId);
      }
      return copy;
    });
  }, []);

  const confirmValid =
    !hasHardDelete || confirmText === hardDeleteConfirmationText(run?.matchedCount ?? 0);

  const handleApprove = useCallback(async () => {
    if (!runId) return;
    try {
      await approveRun(runId, {
        excludedItemIds: excluded.size > 0 ? Array.from(excluded) : undefined,
        confirmation: hasHardDelete
          ? hardDeleteConfirmationText(run?.matchedCount ?? 0)
          : undefined,
      });
      setSuccessMsg('Run approved — applying actions…');
      void fetchRun(runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to approve run');
    }
  }, [runId, excluded, hasHardDelete, run?.matchedCount, approveRun, fetchRun]);

  const handleCancel = useCallback(async () => {
    if (!runId) return;
    try {
      await cancelRun(runId);
      setSuccessMsg('Run cancelled');
      void fetchRun(runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel run');
    }
  }, [runId, cancelRun, fetchRun]);

  // --- Failed-items table ----------------------------------------------------
  //
  // Both memos are keyed on nothing that a poll can change, so the column array
  // and the action array keep their identity across ticks — the second half of
  // the "a refresh must not disturb the user" contract (§18.4). The first half
  // is that the table below is rendered UNCONDITIONALLY.

  const failedItemColumns = useMemo(
    () =>
      buildRunItemColumns<WorkflowRunItem>({
        subjectLabel: 'File',
        itemLabel: (item) => item.media?.filename ?? 'Untitled',
      }),
    [],
  );

  const failedItemActions = useMemo<DataTableRowAction<WorkflowRunItem>[]>(
    () => [
      {
        id: 'view',
        label: 'View',
        icon: <VisibilityIcon fontSize="small" />,
        onClick: (item) => navigate(`/media?item=${item.mediaItemId}`),
      },
    ],
    [navigate],
  );

  // First-load spinner (only when we have no run yet).
  if (!run && isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!run) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">{error ?? 'Workflow run not found.'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 2 }}
          onClick={() => navigate(workflowId ? `/workflows/${workflowId}` : '/workflows')}
        >
          Back to workflow
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          size="small"
          onClick={() => navigate(workflowId ? `/workflows/${workflowId}` : '/workflows')}
          sx={{ mb: 1 }}
        >
          Back to workflow
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="h5" component="h1">
            Workflow run
          </Typography>
          <Chip
            label={runStatusLabel(run.status)}
            color={runStatusColor(run.status)}
            size="small"
          />
          <Typography variant="body2" color="text.secondary">
            {formatRelativeTime(run.createdAt)}
          </Typography>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/*
        Evaluating / running / terminal all render through the shared panel
        (issue #190). `awaiting_approval` stays local below — the exclusion
        grid, per-action impact list and hard-delete confirmation are
        workflow-only and have no equivalent in the other run surfaces.
      */}
      {run.status !== 'awaiting_approval' && (
        <RunProgressPanel
          run={run}
          subjectNoun="item"
          countLabels={{ total: 'Matched' }}
          evaluatingTitle="Evaluating your library…"
          evaluatingDescription="Finding items that match this workflow's conditions. This can take a moment for large libraries."
          runningTitle="Applying actions…"
          terminalSummary={terminalSummary(run)}
          // Cancel is offered while APPLYING only; an evaluating run has
          // nothing to stop yet, matching the pre-shared-panel behaviour.
          canCancel={canApprove && run.status === 'running'}
          onCancel={() => void handleCancel()}
          isCancelling={isSaving}
          cancelLabel="Cancel"
        >
          {isTerminal && run.failedCount > 0 && (
            <Card variant="outlined" sx={{ mt: 1, mb: 2 }}>
              <CardContent>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    mb: 1.5,
                    flexWrap: 'wrap',
                    gap: 1,
                  }}
                >
                  <Typography variant="subtitle2">
                    Failed items ({formatCount(run.failedCount)})
                  </Typography>
                  {canApprove && (
                    <Tooltip title="Coming soon">
                      <span>
                        <Button size="small" variant="outlined" disabled>
                          Retry failed items
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </Box>
                {/*
                  Rendered UNCONDITIONALLY — `loading` is a prop, never a gate.
                  Swapping the table for a spinner (as this page did before
                  #261) unmounts the renderer on every refetch and takes card /
                  row expansion state and the page's scroll offset with it.
                  docs/specs/datatable.md §18.4.
                */}
                <DataTable<WorkflowRunItem>
                  columns={failedItemColumns}
                  rows={items}
                  rowId={(item) => item.id}
                  tableId={WORKFLOW_RUN_ITEMS_TABLE_ID}
                  ariaLabel="Failed workflow run items"
                  density="compact"
                  loading={itemsLoading}
                  emptyState={RUN_ITEMS_EMPTY_STATE}
                  pagination={{
                    page: failedPage,
                    pageSize: failedPageSize,
                    total: itemsMeta?.totalItems ?? items.length,
                    onPaginationChange: ({ page: nextPage, pageSize: nextSize }) => {
                      setFailedPage(nextPage);
                      setFailedPageSize(nextSize);
                    },
                  }}
                  rowActions={failedItemActions}
                  csvExport={{ filename: 'workflow-run-failed-items' }}
                />
              </CardContent>
            </Card>
          )}
        </RunProgressPanel>
      )}

      {/* Awaiting approval */}
      {run.status === 'awaiting_approval' && (
        <Box>
          <Card variant="outlined" sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="h6">
                {formatCount(run.matchedCount)} item{run.matchedCount === 1 ? '' : 's'} matched
              </Typography>
              {run.truncated && (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  <AlertTitle>Results truncated</AlertTitle>
                  This run hit the maximum item cap. Only the first{' '}
                  {formatCount(run.matchedCount)} matching items will be affected — narrow
                  the workflow's conditions if you need to cover more.
                </Alert>
              )}
              {excluded.size > 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {formatCount(excluded.size)} excluded · {formatCount(effectiveMatched)} will
                  be affected
                </Typography>
              )}
            </CardContent>
          </Card>

          {/* Per-action impact list */}
          {impacts.length > 0 && (
            <Card variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  What this run will do
                </Typography>
                <List dense disablePadding>
                  {impacts.map((impact) => (
                    <ListItem key={impact.key} disableGutters>
                      <ListItemText
                        primary={
                          <Typography variant="body2">
                            <strong>{impact.label}:</strong> {formatCount(impact.count)}
                          </Typography>
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              </CardContent>
            </Card>
          )}

          {/* Hard-delete safety panel */}
          {hasHardDelete && canHardDelete && (
            <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>
              <AlertTitle>Permanent deletion</AlertTitle>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                This workflow permanently deletes matching items. This cannot be undone —
                deleted files are not recoverable from Trash. To confirm, type{' '}
                <strong>{hardDeleteConfirmationText(run.matchedCount)}</strong> below.
              </Typography>
              <TextField
                size="small"
                fullWidth
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={hardDeleteConfirmationText(run.matchedCount)}
                error={confirmText.length > 0 && !confirmValid}
                helperText={
                  confirmText.length > 0 && !confirmValid
                    ? 'Confirmation text does not match.'
                    : ' '
                }
              />
            </Alert>
          )}

          {/* Item grid with exclude checkboxes */}
          {canApprove && (
            <Card variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    mb: 1.5,
                    flexWrap: 'wrap',
                    gap: 1,
                  }}
                >
                  <Typography variant="subtitle2">
                    Review matched items
                  </Typography>
                  {excluded.size >= MAX_EXCLUSIONS && (
                    <Typography variant="caption" color="warning.main">
                      Exclusion limit reached ({formatCount(MAX_EXCLUSIONS)}).
                    </Typography>
                  )}
                </Box>
                {itemsLoading && items.length === 0 ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                    <CircularProgress size={28} />
                  </Box>
                ) : (
                  <>
                    <Grid container spacing={1.5}>
                      {items.map((item) => {
                        const isExcluded = excluded.has(item.mediaItemId);
                        return (
                          <Grid
                            key={item.id}
                            size={{ xs: 6, sm: 4, md: 3, lg: 2 }}
                          >
                            <RunItemTile
                              item={item}
                              excluded={isExcluded}
                              checkboxDisabled={
                                !isExcluded && excluded.size >= MAX_EXCLUSIONS
                              }
                              onToggle={handleToggleExclude}
                            />
                          </Grid>
                        );
                      })}
                    </Grid>
                    {itemsMeta && itemsMeta.totalPages > 1 && (
                      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                        <Pagination
                          count={itemsMeta.totalPages}
                          page={itemsPage}
                          onChange={(_, p) => setItemsPage(p)}
                          size="small"
                        />
                      </Box>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Primary actions */}
          {canApprove ? (
            <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                color={hasHardDelete ? 'error' : 'primary'}
                disabled={isSaving || !confirmValid}
                onClick={() => void handleApprove()}
                sx={{ minHeight: 44 }}
              >
                Approve &amp; run
              </Button>
              <Button
                variant="outlined"
                disabled={isSaving}
                onClick={() => void handleCancel()}
                sx={{ minHeight: 44 }}
              >
                Cancel
              </Button>
            </Stack>
          ) : (
            <Alert severity="info">
              This run is awaiting approval. You have read-only access — a circle
              collaborator can approve or cancel it.
            </Alert>
          )}
        </Box>
      )}

      {/* Feedback */}
      <Snackbar
        open={Boolean(successMsg)}
        autoHideDuration={4000}
        onClose={() => setSuccessMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSuccessMsg(null)} severity="success" sx={{ width: '100%' }}>
          {successMsg}
        </Alert>
      </Snackbar>
      <Snackbar
        open={Boolean(errorMsg)}
        autoHideDuration={6000}
        onClose={() => setErrorMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setErrorMsg(null)} severity="error" sx={{ width: '100%' }}>
          {errorMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
