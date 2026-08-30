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
import RateReviewIcon from '@mui/icons-material/RateReview';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useEnhancementBatch } from '../../hooks/useEnhancementBatch';
import { useRunPolling } from '../../hooks/useRunPolling';
import {
  cancelEnhancementBatch,
  listEnhancements,
  type EnhancementBatch,
  type EnhancementListItem,
} from '../../services/enhance';
import RunProgressPanel from '../../components/runs/RunProgressPanel';
import type { RunTerminalSummary } from '../../components/runs/RunProgressPanel';
import {
  RUN_ITEMS_EMPTY_STATE,
  RUN_ITEMS_PAGE_SIZE,
  buildRunItemColumns,
} from '../../components/runs/runItemsTable';
import { DataTable } from '../../components/datatable';
import type { BaseRunItem } from '../../types/runs';
import {
  formatCount,
  formatRelativeTime,
  isTerminalRunStatus,
  runStatusColor,
  runStatusLabel,
} from '../../utils/runFormat';

/**
 * Persistence key for the failed-items table's column/density choices
 * (`user_settings.dataTables['enhancement-batch-items']`,
 * docs/specs/datatable.md §15).
 */
export const ENHANCEMENT_BATCH_ITEMS_TABLE_ID = 'enhancement-batch-items';

// ---------------------------------------------------------------------------
// Bulk AI enhancement — batch progress page (epic #420, issue #423).
//
// Assembly, not construction: Phase 1 serializes a batch as a `BaseRun`
// precisely so this page is `useRunPolling` + `RunProgressPanel` + wording,
// exactly like TrashEmptyRunPage. Nothing here polls, counts or renders
// progress on its own.
//
// Two labels are deliberately NOT the shared defaults, because on this one
// surface the generic wording would be actively wrong:
//
//  - "Cancel remaining", not "Cancel run". Cancelling withdraws the photos
//    still QUEUED; anything already running finishes, because its model call is
//    already billed and aborting would spend the money and bin the result. The
//    button must not promise more than the endpoint does, and the same caveat
//    is spelled out in body copy rather than hidden in a label.
//
//  - "Ready to review", not "Succeeded". For every other run in the app a
//    succeeded item is DONE. Here it means the render finished and the photo is
//    now WAITING ON THE USER — nothing has changed until they decide. Calling
//    that "succeeded" would tell someone the work is over exactly when it
//    starts needing them.
// ---------------------------------------------------------------------------

/** Failed rows are read from the hub listing, so adapt them to the shared shape. */
interface BatchFailedItem extends BaseRunItem {
  mediaItemId: string;
}

/**
 * There is no `/enhancement-batches/:id/items` endpoint — a batch's rows ARE
 * enhancements, listed by `GET /media/enhancements?batchId=`. This maps one to
 * the `BaseRunItem` the shared run-item columns are declared against, so the
 * failed list matches every other run page's instead of being hand-rolled.
 */
function toFailedItem(row: EnhancementListItem): BatchFailedItem {
  return {
    id: row.id,
    mediaItemId: row.mediaItemId,
    status: 'failed',
    error: row.lastError,
    updatedAt: row.updatedAt,
    media: {
      type: 'photo',
      capturedAt: row.capturedAt,
      filename: row.sourceFilename,
      width: row.original.width,
      height: row.original.height,
    },
    thumbnailUrl: row.original.thumbnailUrl,
  };
}

/** Severity + message for a terminal batch. */
function terminalSummary(batch: EnhancementBatch): RunTerminalSummary {
  // An empty batch (everything in the selection was ineligible) is terminal the
  // instant it is created. Saying "Ready to review 0 photos" would read as a
  // failure, and leaving the bar running would be a lie.
  if (batch.matchedCount === 0) {
    return {
      severity: 'info',
      message:
        'Nothing was queued in this batch — every photo in the selection was skipped.',
    };
  }

  switch (batch.status) {
    case 'completed':
      return {
        severity: 'success',
        message: `${formatCount(batch.succeededCount)} photo${
          batch.succeededCount === 1 ? '' : 's'
        } finished enhancing. Review each result to keep or discard it — nothing has been changed yet.`,
      };
    case 'completed_with_errors':
      return {
        severity: 'warning',
        message:
          'The batch finished, but some photos could not be enhanced. Review the failures below.',
      };
    case 'cancelled':
      return {
        severity: 'info',
        message:
          'This batch was cancelled. Photos that had already been enhanced are still waiting for your decision.',
      };
    case 'failed':
      return { severity: 'error', message: batch.lastError ?? 'The batch failed.' };
    default:
      return { severity: 'info', message: '' };
  }
}

/** "3 not photos · 1 too large · 2 already enhancing" — submit-time skips. */
function describeSkipped(batch: EnhancementBatch): string | null {
  const s = batch.skipped;
  if (!s) return null;
  const bits: string[] = [];
  if (s.notPhoto > 0) bits.push(`${formatCount(s.notPhoto)} not photos`);
  if (s.tooLarge > 0) bits.push(`${formatCount(s.tooLarge)} too large`);
  if (s.alreadyLive > 0)
    bits.push(`${formatCount(s.alreadyLive)} already had an enhancement`);
  return bits.length > 0 ? bits.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EnhancementBatchPage() {
  const { id: batchId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { activeCircleRole } = useCircle();

  const { batch, isLoading, error, fetchBatch } = useEnhancementBatch();

  const [failedItems, setFailedItems] = useState<BatchFailedItem[]>([]);
  const [failedTotal, setFailedTotal] = useState(0);
  const [failedLoading, setFailedLoading] = useState(false);
  // ZERO-based (the DataTable convention); converted at the fetch boundary.
  const [failedPage, setFailedPage] = useState(0);
  const [failedPageSize, setFailedPageSize] = useState(RUN_ITEMS_PAGE_SIZE);

  const [isCancelling, setIsCancelling] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Cancelling withdraws queued work, so it needs write access — the same
  // collaborator gate the cancel endpoint enforces (and the same one the review
  // and workflow run pages use).
  const canCancel =
    activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin';

  // Initial load.
  useEffect(() => {
    if (batchId) void fetchBatch(batchId);
  }, [batchId, fetchBatch]);

  // Live progress while the batch is non-terminal.
  useRunPolling({ runId: batchId, status: batch?.status, onPoll: fetchBatch });

  // Load the failed rows once there are any.
  //
  // Keyed on SCALARS, never on `batch` itself: the poll hands back a fresh
  // object every tick, and depending on its identity would refetch the page —
  // and reset the table under the user (docs/specs/datatable.md §18.4).
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
        setFailedItems(res.items.map(toFailedItem));
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

  // Keyed on nothing a poll can churn, so the column array keeps its identity
  // across ticks.
  const failedColumns = useMemo(
    () =>
      buildRunItemColumns<BatchFailedItem>({
        subjectLabel: 'Photo',
        itemLabel: (item) => item.media?.filename ?? item.mediaItemId,
      }),
    [],
  );

  const handleCancel = useCallback(async () => {
    if (!batchId) return;
    setIsCancelling(true);
    try {
      const res = await cancelEnhancementBatch(batchId);
      setSuccessMsg(
        res.cancelled > 0
          ? `Cancelled ${formatCount(res.cancelled)} queued photo${
              res.cancelled === 1 ? '' : 's'
            }`
          : 'Nothing was left to cancel',
      );
      void fetchBatch(batchId);
    } catch (err) {
      // A 400 here is the server explaining itself (already finished) — show
      // its message verbatim rather than a generic failure.
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel the batch');
    } finally {
      setIsCancelling(false);
    }
  }, [batchId, fetchBatch]);

  // First-load spinner (only while we have no batch at all).
  if (!batch && isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Unknown id, or a batch in a circle the caller cannot see — the API answers
  // 404/403 and either way there is nothing to show, so this is a clean
  // not-found rather than an unhandled error.
  if (!batch) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">{error ?? 'Enhancement batch not found.'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 2 }}
          onClick={() => navigate('/enhancements')}
        >
          Back to AI Enhancements
        </Button>
      </Box>
    );
  }

  const terminal = isTerminalRunStatus(batch.status);
  const skippedSummary = describeSkipped(batch);
  const reviewCount = batch.succeededCount;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          size="small"
          onClick={() => navigate('/enhancements')}
          sx={{ mb: 1 }}
        >
          Back to AI Enhancements
        </Button>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <AutoFixHighIcon color="primary" />
          <Typography variant="h5" component="h1">
            AI Enhance batch
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
        {skippedSummary && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {formatCount(batch.queuedCount)} of {formatCount(batch.requestedCount)}{' '}
            selected photos were queued — {skippedSummary}.
          </Typography>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <RunProgressPanel
        run={batch}
        subjectNoun="photo"
        countLabels={{
          // "Succeeded" would read as finished; these are waiting on a person.
          succeeded: 'Ready to review',
          // The only way a batch row is skipped is a cancel withdrawing it.
          skipped: 'Cancelled',
        }}
        runningTitle="Enhancing your photos…"
        terminalSummary={terminalSummary(batch)}
        canCancel={canCancel}
        onCancel={() => void handleCancel()}
        isCancelling={isCancelling}
        cancelLabel="Cancel remaining"
      >
        {/* Reviewing can start the moment the FIRST result lands — a batch of
            200 photos should not hold its first result hostage until the
            two-hundredth finishes. */}
        {reviewCount > 0 && (
          <Button
            variant="contained"
            startIcon={<RateReviewIcon />}
            component={RouterLink}
            to={`/enhancements?batchId=${batch.id}`}
            sx={{ minHeight: 44, mb: 2 }}
          >
            Review {formatCount(reviewCount)} result
            {reviewCount === 1 ? '' : 's'}&nbsp;&rarr;
          </Button>
        )}

        {/* Says exactly what the cancel button does, where the label cannot. */}
        {!terminal && canCancel && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Cancelling stops the photos still queued. Any photo already being
            enhanced finishes — its AI call has already been paid for, so
            stopping it would waste the credit and throw the result away.
          </Typography>
        )}

        {batch.failedCount > 0 && (
          <Card variant="outlined" sx={{ mt: 1, mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                Failed photos ({formatCount(batch.failedCount)})
              </Typography>
              {/*
                Rendered UNCONDITIONALLY — `loading` is a prop, never a gate.
                docs/specs/datatable.md §18.4.
              */}
              <DataTable<BatchFailedItem>
                columns={failedColumns}
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
