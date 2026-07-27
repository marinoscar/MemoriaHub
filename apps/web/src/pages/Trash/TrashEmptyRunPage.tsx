import { useEffect, useState, useCallback } from 'react';
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
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Link,
} from '@mui/material';
import { ArrowBack as ArrowBackIcon } from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useTrashEmptyRun } from '../../hooks/useTrashEmptyRun';
import { useTrashEmptyRunItems } from '../../hooks/useTrashEmptyRunItems';
import { useRunPolling } from '../../hooks/useRunPolling';
import { cancelTrashEmptyRun } from '../../services/trashEmptyRuns';
import RunProgressPanel from '../../components/runs/RunProgressPanel';
import type { RunTerminalSummary } from '../../components/runs/RunProgressPanel';
import {
  formatCaptureDate,
  formatCount,
  formatRelativeTime,
  isTerminalRunStatus,
  runStatusColor,
  runStatusLabel,
} from '../../utils/runFormat';
import type { TrashEmptyRunDetail } from '../../types/trashEmptyRuns';

const ITEMS_PAGE_SIZE = 24;

// ---------------------------------------------------------------------------
// Empty-trash run page.
//
// Polling, progress, counters and the cancel affordance all come from the
// shared run pieces (issue #190) — `useRunPolling` + `RunProgressPanel` —
// so this page only owns the empty-trash wording, its circle_admin cancel
// gate, and the failed-item table.
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

  const [failedPage, setFailedPage] = useState(1);
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
  const terminal = run ? isTerminalRunStatus(run.status) : false;
  useEffect(() => {
    if (!runId || !run || !terminal || run.failedCount <= 0) return;
    void fetchItems(runId, {
      status: 'failed',
      page: failedPage,
      pageSize: ITEMS_PAGE_SIZE,
    });
  }, [runId, run, terminal, failedPage, fetchItems]);

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
              {itemsLoading && items.length === 0 ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                  <CircularProgress size={28} />
                </Box>
              ) : (
                <>
                  <TableContainer sx={{ overflowX: 'auto' }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>File</TableCell>
                          <TableCell>Error</TableCell>
                          <TableCell align="right">Item</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {items.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell sx={{ maxWidth: 220 }}>
                              <Typography
                                variant="body2"
                                noWrap
                                title={item.media?.filename ?? undefined}
                              >
                                {item.media?.filename ?? 'Untitled'}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {formatCaptureDate(item.media?.capturedAt ?? null)}
                              </Typography>
                            </TableCell>
                            <TableCell sx={{ maxWidth: 360 }}>
                              <Typography variant="body2" color="error">
                                {item.error ?? 'Unknown error'}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Link
                                component="button"
                                type="button"
                                variant="body2"
                                onClick={() => navigate(`/media?item=${item.mediaItemId}`)}
                              >
                                View
                              </Link>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  {itemsMeta && itemsMeta.totalPages > 1 && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                      <Pagination
                        count={itemsMeta.totalPages}
                        page={failedPage}
                        onChange={(_, p) => setFailedPage(p)}
                        size="small"
                      />
                    </Box>
                  )}
                </>
              )}
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
