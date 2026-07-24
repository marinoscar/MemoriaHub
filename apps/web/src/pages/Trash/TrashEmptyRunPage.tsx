import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Alert,
  AlertTitle,
  Grid,
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
import { cancelTrashEmptyRun } from '../../services/trashEmptyRuns';
import { formatCount, formatRelativeTime } from '../../utils/workflowFormat';
import type {
  TrashEmptyRunDetail,
  TrashEmptyRunStatus,
} from '../../types/trashEmptyRuns';

const POLL_MS = 2000;
const ITEMS_PAGE_SIZE = 24;

// ---------------------------------------------------------------------------
// Local status helpers (trash-empty has a smaller status set than workflows).
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<TrashEmptyRunStatus> = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

function isTerminal(status: TrashEmptyRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function statusColor(
  status: TrashEmptyRunStatus,
): 'default' | 'info' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'evaluating':
    case 'running':
      return 'info';
    case 'completed':
      return 'success';
    case 'completed_with_errors':
      return 'warning';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'default';
    default:
      return 'default';
  }
}

function statusLabel(status: TrashEmptyRunStatus): string {
  const words = status.split('_');
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Severity + message for a terminal run status. */
function terminalSummary(run: TrashEmptyRunDetail): {
  severity: 'success' | 'warning' | 'error' | 'info';
  message: string;
} {
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

/** Safe short date for a capture timestamp. Never throws. */
function formatCaptureDate(iso: string | null): string {
  if (!iso) return 'No date';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'No date';
    return d.toLocaleDateString();
  } catch {
    return 'No date';
  }
}

// ---------------------------------------------------------------------------
// Compact counts summary (shared by running/terminal states)
// ---------------------------------------------------------------------------

function RunCountsSummary({ run }: { run: TrashEmptyRunDetail }) {
  const stats: { label: string; value: number; color?: string }[] = [
    { label: 'Total', value: run.matchedCount },
    { label: 'Processed', value: run.processedCount },
    { label: 'Deleted', value: run.succeededCount, color: 'success.main' },
    { label: 'Failed', value: run.failedCount, color: 'error.main' },
    { label: 'Skipped', value: run.skippedCount },
  ];
  return (
    <Grid container spacing={2} sx={{ mb: 2 }}>
      {stats.map((s) => (
        <Grid key={s.label} size={{ xs: 6, sm: 4, md: 2.4 }}>
          <Card variant="outlined">
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <Typography variant="h5" sx={{ color: s.color }}>
                {formatCount(s.value)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {s.label}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isCircleAdmin = activeCircleRole === 'circle_admin';

  // Initial load.
  useEffect(() => {
    if (runId) void fetchRun(runId);
  }, [runId, fetchRun]);

  // Poll every 2s while the run is non-terminal; self-stop once terminal.
  useEffect(() => {
    if (!runId || !run) return;
    if (isTerminal(run.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void fetchRun(runId);
    }, POLL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [runId, run, fetchRun]);

  // Load the failed-item table once the run is terminal and has failures.
  const terminal = run ? isTerminal(run.status) : false;
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

  const showCancel = !terminal && isCircleAdmin;

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
          <Chip label={statusLabel(run.status)} color={statusColor(run.status)} size="small" />
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

      {/* Prominent total — the key user ask: how many items are in this run. */}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent sx={{ textAlign: 'center', py: 3 }}>
          <Typography variant="h3" component="p">
            {formatCount(run.matchedCount)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {run.matchedCount === 1 ? 'item in this run' : 'items in this run'}
          </Typography>
        </CardContent>
      </Card>

      {/* Evaluating */}
      {run.status === 'evaluating' && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              Preparing…
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Finding every trashed item in this circle. This can take a moment for a
              large trash bin.
            </Typography>
            <LinearProgress />
          </CardContent>
        </Card>
      )}

      {/* Running */}
      {run.status === 'running' && (
        <Box>
          <Card variant="outlined" sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" gutterBottom>
                Deleting items…
              </Typography>
              <LinearProgress
                variant={run.matchedCount > 0 ? 'determinate' : 'indeterminate'}
                value={
                  run.matchedCount > 0
                    ? Math.min(100, (run.processedCount / run.matchedCount) * 100)
                    : undefined
                }
                sx={{ height: 8, borderRadius: 1, mb: 1 }}
              />
              <Typography variant="body2" color="text.secondary">
                {formatCount(run.processedCount)} of {formatCount(run.matchedCount)} items
                processed
              </Typography>
            </CardContent>
          </Card>
          <RunCountsSummary run={run} />
        </Box>
      )}

      {/* Terminal */}
      {terminal && (
        <Box>
          {(() => {
            const summary = terminalSummary(run);
            return (
              <Alert severity={summary.severity} sx={{ mb: 2 }}>
                <AlertTitle>{statusLabel(run.status)}</AlertTitle>
                {summary.message}
              </Alert>
            );
          })()}

          <RunCountsSummary run={run} />

          {run.failedCount > 0 && (
            <Card variant="outlined" sx={{ mt: 1 }}>
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
        </Box>
      )}

      {/* Cancel (non-terminal, circle_admin only) */}
      {showCancel && (
        <Button
          variant="outlined"
          color="error"
          disabled={isCancelling}
          onClick={() => void handleCancel()}
          sx={{ minHeight: 44, mt: 1 }}
        >
          {isCancelling ? <CircularProgress size={18} /> : 'Cancel run'}
        </Button>
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
