import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box,
  Typography,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Card,
  CardContent,
  Snackbar,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  Visibility as VisibilityIcon,
} from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useTrashEmptyRun } from '../../hooks/useTrashEmptyRun';
import { useTrashEmptyRunItems } from '../../hooks/useTrashEmptyRunItems';
import { useRunPolling } from '../../hooks/useRunPolling';
import { cancelTrashEmptyRun } from '../../services/trashEmptyRuns';
import RunProgressPanel from '../../components/runs/RunProgressPanel';
import type { RunTerminalSummary } from '../../components/runs/RunProgressPanel';
import {
  RUN_ITEMS_EMPTY_STATE,
  RUN_ITEMS_PAGE_SIZE,
  buildRunItemColumns,
} from '../../components/runs/runItemsTable';
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import {
  formatCount,
  formatRelativeTime,
  isTerminalRunStatus,
  runStatusColor,
  runStatusLabel,
} from '../../utils/runFormat';
import type { TrashEmptyRunDetail, TrashEmptyRunItem } from '../../types/trashEmptyRuns';

/**
 * Persistence key for the failed-items table's column/density choices
 * (`user_settings.dataTables['trash-empty-run-items']`,
 * docs/specs/datatable.md §15).
 */
export const TRASH_EMPTY_RUN_ITEMS_TABLE_ID = 'trash-empty-run-items';

// ---------------------------------------------------------------------------
// Empty-trash run page.
//
// Polling, progress, counters and the cancel affordance all come from the
// shared run pieces (issue #190) — `useRunPolling` + `RunProgressPanel` —
// so this page only owns the empty-trash wording, its circle_admin cancel
// gate, and the failed-item table.
//
// Issue #261 (epic #238) replaced that last hand-rolled `<TableContainer>` +
// `<Pagination>` block with the shared DataTable
// (`components/runs/runItemsTable.tsx`). Two rules matter on a page that polls:
// the table is rendered UNCONDITIONALLY with `loading` as a prop, and the
// effect/memos around it key on SCALARS rather than on the `run` object the
// poll replaces each tick. See docs/specs/datatable.md §13.2 / §18.4.
// ---------------------------------------------------------------------------

/** Severity + message for a terminal run status. */
function terminalSummary(run: TrashEmptyRunDetail): RunTerminalSummary {
  switch (run.status) {
    case 'completed':
      return {
        severity: 'success',
        message: `Permanently deleted ${formatCount(run.succeededCount)} item${
          run.succeededCount === 1 ? '' : 's'
        }.`,
      };
    case 'completed_with_errors':
      return {
        severity: 'warning',
        message: 'The run finished, but some items could not be deleted. Review them below.',
      };
    case 'failed':
      return { severity: 'error', message: run.lastError ?? 'The run failed.' };
    case 'cancelled':
      return {
        severity: 'info',
        message: 'This run was cancelled. Items already deleted remain deleted.',
      };
    default:
      return { severity: 'info', message: '' };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TrashEmptyRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { activeCircleRole } = useCircle();

  const { run, isLoading, error, fetchRun } = useTrashEmptyRun();
  const {
    items,
    meta: itemsMeta,
    isLoading: itemsLoading,
    fetchItems,
  } = useTrashEmptyRunItems();

  // ZERO-based (the DataTable convention); converted at the fetch boundary.
  const [failedPage, setFailedPage] = useState(0);
  const [failedPageSize, setFailedPageSize] = useState(RUN_ITEMS_PAGE_SIZE);
  const [isCancelling, setIsCancelling] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Emptying the trash is destructive and irreversible, so cancelling it is
  // gated at circle_admin — stricter than the collaborator gate the review and
  // workflow runs use.
  const isCircleAdmin = activeCircleRole === 'circle_admin';

  // Initial load.
  useEffect(() => {
    if (runId) void fetchRun(runId);
  }, [runId, fetchRun]);

  // Live progress while the run is non-terminal.
  useRunPolling({ runId, status: run?.status, onPoll: fetchRun });

  // Load the failed-item table once the run is terminal and has failures.
  //
  // Keyed on the two SCALARS this depends on, never on `run` itself: the
  // run-detail poll hands back a fresh object every tick, and depending on that
  // identity would refetch the item page — and reset the table with it.
  const terminal = run ? isTerminalRunStatus(run.status) : false;
  const failedCount = run?.failedCount ?? 0;
  useEffect(() => {
    if (!runId || !terminal || failedCount <= 0) return;
    void fetchItems(runId, {
      status: 'failed',
      page: failedPage + 1, // the API is 1-based, the table 0-based
      pageSize: failedPageSize,
    });
  }, [runId, terminal, failedCount, failedPage, failedPageSize, fetchItems]);

  // --- Failed-items table ----------------------------------------------------
  //
  // Keyed on nothing a poll can churn, so the column and action arrays keep
  // their identity across ticks. That, plus rendering the table unconditionally
  // with `loading` as a prop, is what keeps a refresh from disturbing the user
  // (docs/specs/datatable.md §18.4).

  const failedItemColumns = useMemo(
    () =>
      buildRunItemColumns<TrashEmptyRunItem>({
        subjectLabel: 'File',
        itemLabel: (item) => item.media?.filename ?? 'Untitled',
      }),
    [],
  );

  const failedItemActions = useMemo<DataTableRowAction<TrashEmptyRunItem>[]>(
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

  const handleCancel = useCallback(async () => {
    if (!runId) return;
    setIsCancelling(true);
    try {
      await cancelTrashEmptyRun(runId);
      setSuccessMsg('Run cancelled');
      void fetchRun(runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel run');
    } finally {
      setIsCancelling(false);
    }
  }, [runId, fetchRun]);

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
        <Alert severity="error">{error ?? 'Empty-trash run not found.'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 2 }}
          onClick={() => navigate('/trash')}
        >
          Back to Trash
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
          onClick={() => navigate('/trash')}
          sx={{ mb: 1 }}
        >
          Back to Trash
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="h5" component="h1">
            Empty Trash
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

      <RunProgressPanel
        run={run}
        subjectNoun="item"
        countLabels={{ succeeded: 'Deleted' }}
        evaluatingDescription="Finding every trashed item in this circle. This can take a moment for a large trash bin."
        runningTitle="Deleting items…"
        terminalSummary={terminalSummary(run)}
        canCancel={isCircleAdmin}
        onCancel={() => void handleCancel()}
        isCancelling={isCancelling}
      >
        {terminal && run.failedCount > 0 && (
          <Card variant="outlined" sx={{ mt: 1, mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                Failed items ({formatCount(run.failedCount)})
              </Typography>
              {/*
                Rendered UNCONDITIONALLY — `loading` is a prop, never a gate.
                docs/specs/datatable.md §18.4.
              */}
              <DataTable<TrashEmptyRunItem>
                columns={failedItemColumns}
                rows={items}
                rowId={(item) => item.id}
                tableId={TRASH_EMPTY_RUN_ITEMS_TABLE_ID}
                ariaLabel="Failed items"
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
                csvExport={{ filename: 'empty-trash-failed-items' }}
              />
            </CardContent>
          </Card>
        )}
      </RunProgressPanel>

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
