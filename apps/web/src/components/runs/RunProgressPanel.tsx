import type { ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  LinearProgress,
  Typography,
} from '@mui/material';
import type { BaseRun } from '../../types/runs';
import {
  formatCount,
  isTerminalRunStatus,
  runProgressPercent,
  runStatusLabel,
} from '../../utils/runFormat';

// ---------------------------------------------------------------------------
// Shared async-run progress panel (issue #190).
//
// One presentational component for every run page — workflow, trash-empty,
// location-suggestion and review runs — replacing three copy-pasted
// hero/LinearProgress/RunCountsSummary blocks.
//
// Purely presentational: it owns no polling, no fetching and no RBAC. The host
// page decides whether the cancel action is visible (`canCancel`) and what it
// does (`onCancel`), so each queue keeps its own permission rules.
// ---------------------------------------------------------------------------

/** Per-tile labels, so callers can say "Deleted" vs "Applied" vs "Resolved". */
export interface RunCountLabels {
  total?: string;
  processed?: string;
  /** The success tile — the one that genuinely differs per queue. */
  succeeded?: string;
  failed?: string;
  skipped?: string;
}

const DEFAULT_COUNT_LABELS: Required<RunCountLabels> = {
  total: 'Total',
  processed: 'Processed',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Terminal alert content. Hosts supply domain wording; a default is derived. */
export interface RunTerminalSummary {
  severity: 'success' | 'warning' | 'error' | 'info';
  message: string;
}

/**
 * Generic terminal wording used when the host does not supply its own.
 *
 * Note what this deliberately does NOT do: it never compares `processedCount`
 * against `matchedCount`. A completed run may legitimately process fewer
 * subjects than it matched — subjects cascade-deleted mid-run shrink the work
 * set — and surfacing that gap as a stall or a failure would be wrong.
 */
export function defaultTerminalSummary(
  run: BaseRun,
  succeededLabel = 'Processed',
): RunTerminalSummary {
  switch (run.status) {
    case 'completed':
      return {
        severity: 'success',
        message: `${succeededLabel} ${formatCount(run.succeededCount)} item${
          run.succeededCount === 1 ? '' : 's'
        }.`,
      };
    case 'completed_with_errors':
      return {
        severity: 'warning',
        message: 'The run finished, but some items could not be processed. Review them below.',
      };
    case 'failed':
      return { severity: 'error', message: run.lastError ?? 'The run failed.' };
    case 'cancelled':
      return {
        severity: 'info',
        message: 'This run was cancelled. Work already completed has been kept.',
      };
    case 'expired':
      return { severity: 'warning', message: 'This run expired before it was approved.' };
    default:
      return { severity: 'info', message: '' };
  }
}

export interface RunProgressPanelProps {
  /** The run to render. Only the shared `BaseRun` fields are read. */
  run: BaseRun;

  /** Singular noun for the hero subtitle, e.g. "item" / "suggestion" / "group". */
  subjectNoun?: string;
  /** Plural noun for the hero subtitle. Defaults to `subjectNoun + 's'`. */
  subjectNounPlural?: string;

  /** Per-tile count labels. Unset keys fall back to generic wording. */
  countLabels?: RunCountLabels;

  /** Heading + body shown while the run is still discovering subjects. */
  evaluatingTitle?: string;
  evaluatingDescription?: string;
  /** Heading shown above the determinate progress bar while running. */
  runningTitle?: string;

  /**
   * Terminal alert content. Pass `null` to suppress the alert entirely;
   * omit it to use `defaultTerminalSummary`.
   */
  terminalSummary?: RunTerminalSummary | null;

  /** Whether to render the cancel action. The host owns the RBAC decision. */
  canCancel?: boolean;
  onCancel?: () => void;
  isCancelling?: boolean;
  cancelLabel?: string;

  /**
   * Slot rendered directly beneath the hero, above the progress/count blocks.
   *
   * This is the intended home for issue #189's confidence sort controls —
   * keep run-scoped controls here rather than re-adding them per page.
   */
  sortControls?: ReactNode;

  /** Free slot rendered after the counts (failed-item tables, etc.). */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Count tiles
// ---------------------------------------------------------------------------

function RunCountsSummary({
  run,
  labels,
}: {
  run: BaseRun;
  labels: Required<RunCountLabels>;
}) {
  const stats: { label: string; value: number; color?: string }[] = [
    { label: labels.total, value: run.matchedCount },
    { label: labels.processed, value: run.processedCount },
    { label: labels.succeeded, value: run.succeededCount, color: 'success.main' },
    { label: labels.failed, value: run.failedCount, color: 'error.main' },
    { label: labels.skipped, value: run.skippedCount },
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
// Panel
// ---------------------------------------------------------------------------

export default function RunProgressPanel({
  run,
  subjectNoun = 'item',
  subjectNounPlural,
  countLabels,
  evaluatingTitle = 'Preparing…',
  evaluatingDescription = 'Finding everything this run applies to. This can take a moment for a large backlog.',
  runningTitle = 'Processing…',
  terminalSummary,
  canCancel = false,
  onCancel,
  isCancelling = false,
  cancelLabel = 'Cancel run',
  sortControls,
  children,
}: RunProgressPanelProps) {
  const labels: Required<RunCountLabels> = { ...DEFAULT_COUNT_LABELS, ...countLabels };
  const plural = subjectNounPlural ?? `${subjectNoun}s`;
  const terminal = isTerminalRunStatus(run.status);

  // `null` → nothing to divide by yet, so the bar stays indeterminate.
  // Otherwise already clamped to 0–100 by `runProgressPercent`.
  const percent = runProgressPercent(run.processedCount, run.matchedCount);

  const summary =
    terminalSummary === undefined
      ? defaultTerminalSummary(run, labels.succeeded)
      : terminalSummary;

  return (
    <Box>
      {/* Hero — the headline question is "how much is in this run". */}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent sx={{ textAlign: 'center', py: 3 }}>
          <Typography variant="h3" component="p">
            {formatCount(run.matchedCount)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {run.matchedCount === 1 ? `${subjectNoun} in this run` : `${plural} in this run`}
          </Typography>
        </CardContent>
      </Card>

      {/* Slot: issue #189's confidence sort controls land here. */}
      {sortControls && <Box sx={{ mb: 2 }}>{sortControls}</Box>}

      {/* Evaluating — subject count is not known yet, so the bar is indeterminate. */}
      {run.status === 'evaluating' && (
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              {evaluatingTitle}
            </Typography>
            {evaluatingDescription && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {evaluatingDescription}
              </Typography>
            )}
            <LinearProgress />
          </CardContent>
        </Card>
      )}

      {/* Running — determinate once we know the denominator. */}
      {run.status === 'running' && (
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              {runningTitle}
            </Typography>
            <LinearProgress
              variant={percent === null ? 'indeterminate' : 'determinate'}
              value={percent ?? undefined}
              sx={{ height: 8, borderRadius: 1, mb: 1 }}
            />
            <Typography variant="body2" color="text.secondary">
              {formatCount(run.processedCount)} of {formatCount(run.matchedCount)} {plural}{' '}
              processed
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Terminal summary alert. */}
      {terminal && summary && summary.message && (
        <Alert severity={summary.severity} sx={{ mb: 2 }}>
          <AlertTitle>{runStatusLabel(run.status)}</AlertTitle>
          {summary.message}
        </Alert>
      )}

      {/* Counts are meaningless before evaluation finishes. */}
      {run.status !== 'evaluating' && <RunCountsSummary run={run} labels={labels} />}

      {children}

      {/* Cancel — visibility and behaviour are entirely the host's call. */}
      {canCancel && !terminal && (
        <Button
          variant="outlined"
          color="error"
          disabled={isCancelling}
          onClick={onCancel}
          sx={{ minHeight: 44, mt: 1 }}
        >
          {isCancelling ? <CircularProgress size={18} /> : cancelLabel}
        </Button>
      )}
    </Box>
  );
}
