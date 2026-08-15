import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useNavigate, useParams } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useEnhancementBatch } from '../../hooks/useEnhancementBatch';
import { useRunPolling } from '../../hooks/useRunPolling';
import { cancelEnhancementBatch, listEnhancements } from '../../services/enhance';
import type { EnhancementBatch, EnhancementListItem } from '../../services/enhance';
import RunProgressPanel from '../../components/runs/RunProgressPanel';
import type { RunTerminalSummary } from '../../components/runs/RunProgressPanel';
import {
  RUN_ITEMS_EMPTY_STATE,
  RUN_ITEMS_PAGE_SIZE,
  buildRunItemColumns,
} from '../../components/runs/runItemsTable';
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import type { BaseRunItem } from '../../types/runs';
import {
  formatCount,
  formatRelativeTime,
  isTerminalRunStatus,
  runStatusColor,
  runStatusLabel,
} from '../../utils/runFormat';
import { describeParams } from './PendingEnhancementsTab';

/**
 * Persistence key for the failed-items table's column/density choices
 * (`user_settings.dataTables['enhancement-batch-items']`,
 * docs/specs/datatable.md §15).
 */
export const ENHANCEMENT_BATCH_ITEMS_TABLE_ID = 'enhancement-batch-items';

// ---------------------------------------------------------------------------
// Bulk AI enhancement — batch progress page (epic #420, issue #423).
//
// Assembly, not construction: issue #421 shaped the batch payload as a
// `BaseRun`, so polling, the progress bar, the counter tiles and the cancel
// affordance all come from the shared run pieces (`useRunPolling` +
// `RunProgressPanel`). This page owns only three things:
//
//  1. The wording — two labels here are load-bearing rather than cosmetic:
//     "Cancel remaining" (cancel stops QUEUED work; anything already rendering
//     is already billed and is left to finish), and "Ready to review" for the
//     succeeded tile (everywhere else in the app "succeeded" means done; here
//     it means WAITING FOR YOU, and calling it "Succeeded" would tell users the
//     work is finished when it has only started needing them).
//  2. The review handoff, enabled the moment the first result lands rather than
//     at completion — reviewing a 26-photo batch should not wait for photo 26.
//  3. The failed-items list, sourced from the enhancements listing filtered by
//     `batchId`: batches deliberately have no `review_run_items` analogue, so
//     there is no per-item run endpoint to call.
// ---------------------------------------------------------------------------

/** The failed enhancements table's row — a list row mapped onto `BaseRunItem`. */
interface FailedEnhancementRow extends BaseRunItem {
  mediaItemId: string;
}

/**
 * Project an enhancement list row onto the shared run-item shape so
 * `buildRunItemColumns` renders it exactly like every other run's failures.
 */
function toFailedRow(item: EnhancementListItem): FailedEnhancementRow {
  return {
    id: item.id,
    mediaItemId: item.mediaItemId,
    status: 'failed',
    error: item.lastError,
    updatedAt: item.updatedAt,
    media: {
      type: 'photo',
      capturedAt: item.capturedAt,
      filename: item.sourceFilename,
      width: item.original.width,
      height: item.original.height,
    },
    thumbnailUrl: item.original.thumbnailUrl,
  };
}

/** Severity + message for a terminal batch. */
function terminalSummary(batch: EnhancementBatch): RunTerminalSummary {
  switch (batch.status) {
    case 'completed':
      return {
        severity: 'success',
        message: `${formatCount(batch.succeededCount)} photo${
          batch.succeededCount === 1 ? '' : 's'
        } finished enhancing and ${
          batch.succeededCount === 1 ? 'is' : 'are'
        } waiting for your review.`,
      };
    case 'completed_with_errors':
      return {
        severity: 'warning',
        message:
          'The batch finished, but some photos could not be enhanced. Review the failures below.',
      };
    case 'failed':
      return { severity: 'error', message: batch.lastError ?? 'The batch failed.' };
    case 'cancelled':
      return {
        severity: 'info',
        message:
          'This batch was cancelled. Photos that were already being enhanced finished, and their results are still waiting for you.',
      };
    default:
      return { severity: 'info', message: '' };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EnhancementBatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();
  const { activeCircle, activeCircleRole } = useCircle();

  const { batch, isLoading, error, fetchBatch } = useEnhancementBatch();

  const [failedItems, setFailedItems] = useState<FailedEnhancementRow[]>([]);
  const [failedTotal, setFailedTotal] = useState(0);
  const [failedLoading, setFailedLoading] = useState(false);
  // ZERO-based (the DataTable convention); converted at the fetch boundary.
  const [failedPage, setFailedPage] = useState(0);
  const [failedPageSize, setFailedPageSize] = useState(RUN_ITEMS_PAGE_SIZE);

  const [isCancelling, setIsCancelling] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initial load.
  useEffect(() => {
    if (batchId) void fetchBatch(batchId);
  }, [batchId, fetchBatch]);

  // Live progress while the batch is non-terminal. The API reports a real
  // terminal RunStatus, so this stops itself.
  useRunPolling({ runId: batchId, status: batch?.status, onPoll: fetchBatch });

  // Load the failed-item table whenever there are failures to show.
  //
  // Keyed on SCALARS, never on `batch` itself: the poll hands back a fresh
  // object every tick, and depending on that identity would refetch the item
  // page — and reset the table with it (docs/specs/datatable.md §18.4).
  const circleId = batch?.circleId;
  const failedCount = batch?.failedCount ?? 0;
  useEffect(() => {
    if (!batchId || !circleId || failedCount <= 0) return;
    let cancelled = false;
    setFailedLoading(true);
    listEnhancements({
      circleId,
      batchId,
      status: 'failed',
      page: failedPage + 1, // the API is 1-based, the table 0-based
      pageSize: failedPageSize,
    })
      .then((res) => {
        if (cancelled) return;
        setFailedItems(res.items.map(toFailedRow));
        setFailedTotal(res.meta?.totalItems ?? res.items.length);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg(
          err instanceof Error ? err.message : 'Failed to load the failed photos',
        );
      })
      .finally(() => {
        if (!cancelled) setFailedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, circleId, failedCount, failedPage, failedPageSize]);

  // --- Failed-items table ----------------------------------------------------
  // Keyed on nothing a poll can churn, so these arrays keep their identity
  // across ticks.

  const failedItemColumns = useMemo(
    () =>
      buildRunItemColumns<FailedEnhancementRow>({
        subjectLabel: 'Photo',
        itemLabel: (item) => item.media?.filename ?? item.mediaItemId,
      }),
    [],
  );

  const failedItemActions = useMemo<DataTableRowAction<FailedEnhancementRow>[]>(
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
    if (!batchId) return;
    setIsCancelling(true);
    setErrorMsg(null);
    try {
      const res = await cancelEnhancementBatch(batchId);
      setSuccessMsg(
        res.cancelled === 1
          ? '1 queued photo was cancelled'
          : `${formatCount(res.cancelled)} queued photos were cancelled`,
      );
      void fetchBatch(batchId);
    } catch (err) {
      // Surface the SERVER's message — a 400 here means "already finished",
      // which is a real answer, not a generic failure.
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel the batch');
      // Re-read: a terminal batch is exactly the case the button should vanish.
      void fetchBatch(batchId);
    } finally {
      setIsCancelling(false);
    }
  }, [batchId, fetchBatch]);

  // First-load spinner (only when we have no batch yet).
  if (!batch && isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Unknown id, or a batch in a circle the caller cannot see: a clean
  // not-found, never an unhandled error.
  if (!batch) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">{error ?? 'Enhancement batch not found.'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 2, minHeight: 44 }}
          onClick={() => navigate('/enhancements')}
        >
          Back to AI Enhancements
        </Button>
      </Box>
    );
  }

  const terminal = isTerminalRunStatus(batch.status);

  // Cancelling needs media:write + the per-circle collaborator role (the
  // location-suggestion precedent, not trash-empty's circle_admin). Scoped to
  // the ACTIVE circle: a batch deep-linked from another circle carries no role
  // we can trust here, so the affordance is withheld rather than guessed at.
  const canCancel =
    batch.circleId === activeCircle?.id &&
    (activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin');

  const paramsSummary = describeParams(batch);

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          size="small"
          onClick={() => navigate('/enhancements')}
          sx={{ mb: 1, minHeight: 44 }}
        >
          Back to AI Enhancements
        </Button>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <AutoFixHighIcon color="primary" />
          <Typography variant="h5" component="h1">
            AI enhancement batch
          </Typography>
          <Chip
            label={runStatusLabel(batch.status)}
            color={runStatusColor(batch.status)}
            size="small"
          />
          <Typography variant="body2" color="text.secondary">
            {formatRelativeTime(batch.createdAt)}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {paramsSummary}
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <RunProgressPanel
        run={batch}
        subjectNoun="photo"
        // "Ready to review", not "Succeeded" — see the header comment.
        countLabels={{ succeeded: 'Ready to review', skipped: 'Cancelled' }}
        runningTitle="Enhancing photos…"
        terminalSummary={terminalSummary(batch)}
        canCancel={canCancel}
        onCancel={() => void handleCancel()}
        isCancelling={isCancelling}
        // The label must not promise more than the backend delivers.
        cancelLabel="Cancel remaining"
      >
        {/* Review handoff — deliberately live before the batch finishes. */}
        <Stack spacing={1} sx={{ mb: 2 }}>
          <Box>
            <Button
              variant="contained"
              startIcon={<CompareArrowsIcon />}
              disabled={batch.succeededCount === 0}
              onClick={() => navigate(`/enhancements?batchId=${batch.id}`)}
              sx={{ minHeight: 44 }}
            >
              {batch.succeededCount === 0
                ? 'No results yet'
                : `Review ${formatCount(batch.succeededCount)} result${
                    batch.succeededCount === 1 ? '' : 's'
                  } →`}
            </Button>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {terminal
              ? 'Nothing has been changed yet — each result waits for you to compare and decide.'
              : 'You can start reviewing finished photos while the rest are still enhancing. Nothing is changed until you decide on each one.'}
          </Typography>
          {canCancel && !terminal && (
            <Typography variant="body2" color="text.secondary">
              Cancelling stops the photos still waiting in the queue. Any photo
              already being enhanced finishes — its AI credits are already spent,
              so stopping it would throw the result away for nothing.
            </Typography>
          )}
        </Stack>

        {failedCount > 0 && (
          <Card variant="outlined" sx={{ mt: 1, mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                Failed photos ({formatCount(failedCount)})
              </Typography>
              {/*
                Rendered UNCONDITIONALLY — `loading` is a prop, never a gate.
                docs/specs/datatable.md §18.4.
              */}
              <DataTable<FailedEnhancementRow>
                columns={failedItemColumns}
                rows={failedItems}
                rowId={(item) => item.id}
                tableId={ENHANCEMENT_BATCH_ITEMS_TABLE_ID}
                ariaLabel="Failed photos"
                density="compact"
                loading={failedLoading}
                emptyState={RUN_ITEMS_EMPTY_STATE}
                pagination={{
                  page: failedPage,
                  pageSize: failedPageSize,
                  total: failedTotal,
                  onPaginationChange: ({ page: nextPage, pageSize: nextSize }) => {
                    setFailedPage(nextPage);
                    setFailedPageSize(nextSize);
                  },
                }}
                rowActions={failedItemActions}
                csvExport={{ filename: 'enhancement-batch-failed-photos' }}
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
