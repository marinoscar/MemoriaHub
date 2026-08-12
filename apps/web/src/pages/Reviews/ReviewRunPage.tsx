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
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useParams, useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useReviewRun } from '../../hooks/useReviewRun';
import { useReviewRunItems } from '../../hooks/useReviewRunItems';
import { useRunPolling } from '../../hooks/useRunPolling';
import { cancelReviewRun } from '../../services/reviewRuns';
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
import type {
  ReviewRunAction,
  ReviewRunDetail,
  ReviewRunItem,
  ReviewRunSubject,
} from '../../types/reviewRuns';

/**
 * Persistence key for the failed-items table's column/density choices
 * (`user_settings.dataTables['review-run-items']`, docs/specs/datatable.md
 * §15). ONE id across all three review queues: the table is the same table with
 * the same columns whichever queue produced the run, so a user who widens the
 * Error column while reviewing bursts should find it widened for duplicates.
 */
export const REVIEW_RUN_ITEMS_TABLE_ID = 'review-run-items';

// ---------------------------------------------------------------------------
// Generic review-run page (issue #190), shared by all three review queues.
//
// Everything queue-specific is derived from the run's `subjectType` + `action`,
// so bursts, duplicates and location suggestions render the identical panel
// with the right nouns, the right success-tile label, and the right links back
// into their own queue.
//
// Issue #261 (epic #238) replaced the hand-rolled failed-items
// `<TableContainer>` + `<Pagination>` block with the shared DataTable
// (`components/runs/runItemsTable.tsx`). Two rules matter on a page that polls:
// the table is rendered UNCONDITIONALLY with `loading` as a prop, and every
// memo/effect around it keys on SCALARS rather than on the `run` object the
// poll replaces each tick. See docs/specs/datatable.md §13.2 / §18.4.
// ---------------------------------------------------------------------------

interface ReviewRunPresentation {
  /** Page heading. */
  title: string;
  /** Back-navigation target and label. */
  backPath: string;
  backLabel: string;
  subjectNoun: string;
  subjectNounPlural: string;
  /** Label for the success count tile — "Resolved" / "Dismissed" / "Applied" … */
  succeededLabel: string;
  evaluatingDescription: string;
  runningTitle: string;
  /** Heading above the failed-items table. */
  failedTitle: string;
  /**
   * Deep link for one failed subject, or `null` when the queue has no
   * per-subject page (location suggestions are reviewed as a single list).
   */
  subjectLink: (subjectId: string) => string | null;
}

/** True for the two "below the threshold" actions (dismiss / reject). */
function isBelowThresholdAction(run: ReviewRunDetail): boolean {
  return run.action === 'dismiss' || run.action === 'reject';
}

/**
 * Derive the per-queue wording and links.
 *
 * Takes the two discriminators rather than the whole run so a `useMemo` over it
 * can depend on scalars — the run object itself is replaced on every poll tick,
 * and keying on it would rebuild the row-action array (and every control's
 * identity with it) twice a second.
 */
function describeReviewRun(
  subjectType: ReviewRunSubject,
  action: ReviewRunAction,
): ReviewRunPresentation {
  const dismissing = action === 'dismiss';

  switch (subjectType) {
    case 'burst_group':
      return {
        title: dismissing ? 'Dismiss burst groups' : 'Resolve burst groups',
        backPath: '/bursts',
        backLabel: 'Back to Bursts',
        subjectNoun: 'group',
        subjectNounPlural: 'groups',
        succeededLabel: dismissing ? 'Dismissed' : 'Resolved',
        evaluatingDescription:
          'Finding every pending burst group in this circle that matches the confidence threshold. This can take a moment for a large backlog.',
        runningTitle: dismissing ? 'Dismissing groups…' : 'Resolving groups…',
        failedTitle: 'Failed groups',
        subjectLink: (id) => `/bursts/${id}`,
      };
    case 'duplicate_group':
      return {
        title: dismissing ? 'Dismiss duplicate groups' : 'Resolve duplicate groups',
        backPath: '/duplicates',
        backLabel: 'Back to Duplicates',
        subjectNoun: 'group',
        subjectNounPlural: 'groups',
        succeededLabel: dismissing ? 'Dismissed' : 'Resolved',
        evaluatingDescription:
          'Finding every pending duplicate group in this circle that matches the confidence threshold. This can take a moment for a large backlog.',
        runningTitle: dismissing ? 'Dismissing groups…' : 'Resolving groups…',
        failedTitle: 'Failed groups',
        subjectLink: (id) => `/duplicates/${id}`,
      };
    case 'location_suggestion':
    default: {
      const rejecting = action === 'reject';
      return {
        title: rejecting ? 'Bulk reject locations' : 'Bulk accept locations',
        backPath: '/location-suggestions',
        backLabel: 'Back to Location Suggestions',
        subjectNoun: 'suggestion',
        subjectNounPlural: 'suggestions',
        succeededLabel: rejecting ? 'Rejected' : 'Applied',
        evaluatingDescription:
          'Finding every pending suggestion in this circle that matches the confidence threshold. This can take a moment for a large backlog.',
        runningTitle: rejecting ? 'Rejecting suggestions…' : 'Applying locations…',
        failedTitle: 'Failed suggestions',
        subjectLink: () => null,
      };
    }
  }
}

/**
 * Terminal alert wording.
 *
 * Note this never compares `processedCount` to `matchedCount`: a completed run
 * may legitimately process fewer subjects than it matched, because a subject
 * can be cascade-deleted mid-run (a duplicate group dropping below the member
 * floor, a suggestion vanishing with its media item). That gap is success.
 */
function terminalSummary(
  run: ReviewRunDetail,
  presentation: ReviewRunPresentation,
): RunTerminalSummary {
  const n = run.succeededCount;
  const noun = n === 1 ? presentation.subjectNoun : presentation.subjectNounPlural;

  switch (run.status) {
    case 'completed':
      return {
        severity: 'success',
        message: `${presentation.succeededLabel} ${formatCount(n)} ${noun}.`,
      };
    case 'completed_with_errors':
      return {
        severity: 'warning',
        message: `The run finished, but some ${presentation.subjectNounPlural} could not be processed. Review them below.`,
      };
    case 'failed':
      return { severity: 'error', message: run.lastError ?? 'The run failed.' };
    case 'cancelled':
      return {
        severity: 'info',
        message: `This run was cancelled. ${
          presentation.subjectNounPlural.charAt(0).toUpperCase() +
          presentation.subjectNounPlural.slice(1)
        } already processed stay processed.`,
      };
    default:
      return { severity: 'info', message: '' };
  }
}

/** Display name for a failed run item. */
function itemLabel(item: ReviewRunItem): string {
  if (item.media?.filename) return item.media.filename;
  return item.subjectId ? item.subjectId.slice(0, 8) : 'Unknown';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReviewRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { activeCircleRole } = useCircle();

  const { run, isLoading, error, fetchRun } = useReviewRun();
  const {
    items,
    meta: itemsMeta,
    isLoading: itemsLoading,
    fetchItems,
  } = useReviewRunItems();

  // ZERO-based (the DataTable convention); converted at the fetch boundary.
  const [failedPage, setFailedPage] = useState(0);
  const [failedPageSize, setFailedPageSize] = useState(RUN_ITEMS_PAGE_SIZE);
  const [isCancelling, setIsCancelling] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Cancel needs collaborator (matching the location-suggestion precedent,
  // NOT trash-empty's circle_admin).
  const canCancel =
    activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin';

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

  const handleCancel = useCallback(async () => {
    if (!runId) return;
    setIsCancelling(true);
    try {
      await cancelReviewRun(runId);
      setSuccessMsg('Run cancelled');
      void fetchRun(runId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel run');
    } finally {
      setIsCancelling(false);
    }
  }, [runId, fetchRun]);

  // --- Failed-items table ----------------------------------------------------
  //
  // Both memos live ABOVE the early returns (hooks must) and are keyed on
  // scalars a poll cannot churn, so the column and action arrays keep their
  // identity across ticks. That, plus rendering the table unconditionally with
  // `loading` as a prop, is what keeps a refresh from disturbing the user
  // (docs/specs/datatable.md §18.4).

  const subjectType = run?.subjectType;
  const action = run?.action;

  const failedItemColumns = useMemo(
    () =>
      buildRunItemColumns<ReviewRunItem>({
        // "Subject", not "File": a burst/duplicate row is a GROUP, and may have
        // no media row at all — `itemLabel` falls back to the subject id.
        subjectLabel: 'Subject',
        itemLabel,
      }),
    [],
  );

  const failedItemActions = useMemo<DataTableRowAction<ReviewRunItem>[]>(() => {
    if (!subjectType || !action) return [];
    const { subjectLink, backPath } = describeReviewRun(subjectType, action);
    return [
      {
        id: 'view',
        label: 'View',
        icon: <VisibilityIcon fontSize="small" />,
        onClick: (item) =>
          navigate((item.subjectId ? subjectLink(item.subjectId) : null) ?? backPath),
      },
    ];
  }, [navigate, subjectType, action]);

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
        <Alert severity="error">{error ?? 'Review run not found.'}</Alert>
        <Button startIcon={<ArrowBackIcon />} sx={{ mt: 2 }} onClick={() => navigate('/')}>
          Back to Home
        </Button>
      </Box>
    );
  }

  const presentation = describeReviewRun(run.subjectType, run.action);
  const thresholdLabel = `${isBelowThresholdAction(run) ? '<' : '≥'} ${run.threshold}%`;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          size="small"
          onClick={() => navigate(presentation.backPath)}
          sx={{ mb: 1 }}
        >
          {presentation.backLabel}
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="h5" component="h1">
            {presentation.title}
          </Typography>
          <Chip
            label={runStatusLabel(run.status)}
            color={runStatusColor(run.status)}
            size="small"
          />
          <Chip label={thresholdLabel} size="small" variant="outlined" />
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
        subjectNoun={presentation.subjectNoun}
        subjectNounPlural={presentation.subjectNounPlural}
        countLabels={{ succeeded: presentation.succeededLabel }}
        evaluatingDescription={presentation.evaluatingDescription}
        runningTitle={presentation.runningTitle}
        terminalSummary={terminalSummary(run, presentation)}
        canCancel={canCancel}
        onCancel={() => void handleCancel()}
        isCancelling={isCancelling}
      >
        {terminal && run.failedCount > 0 && (
          <Card variant="outlined" sx={{ mt: 1, mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                {presentation.failedTitle} ({formatCount(run.failedCount)})
              </Typography>
              {/*
                Rendered UNCONDITIONALLY — `loading` is a prop, never a gate.
                docs/specs/datatable.md §18.4.
              */}
              <DataTable<ReviewRunItem>
                columns={failedItemColumns}
                rows={items}
                rowId={(item) => item.id}
                tableId={REVIEW_RUN_ITEMS_TABLE_ID}
                ariaLabel={presentation.failedTitle}
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
                csvExport={{ filename: 'review-run-failed-items' }}
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
