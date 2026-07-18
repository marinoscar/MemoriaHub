// ---------------------------------------------------------------------------
// Workflow run history — props-driven list of past runs for a single workflow.
//
// Each row shows a trigger badge (Manual / On new media / Scheduled — same
// `triggerLabel` used on the workflow card), a status chip, matched/processed
// counts with an optional "truncated" indicator, a relative created time, and
// navigates to the run detail page (/workflows/:id/runs/:runId).
//
// Kept router-free and presentational: navigation is delegated via `onOpenRun`
// so it can be unit-tested without a Router. Loading / empty / error states
// follow the app conventions (CircularProgress / muted caption / Alert).
// ---------------------------------------------------------------------------

import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  Alert,
  Card,
  CardActionArea,
  Stack,
  Pagination,
} from '@mui/material';
import {
  TouchApp as TouchAppIcon,
  AutoAwesome as AutoAwesomeIcon,
  Schedule as ScheduleIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import type { WorkflowRun, WorkflowTriggerType } from '../../types/workflows';
import {
  triggerLabel,
  runStatusColor,
  runStatusLabel,
  formatRelativeTime,
  formatCount,
} from '../../utils/workflowFormat';

interface WorkflowRunHistoryProps {
  runs: WorkflowRun[];
  isLoading: boolean;
  error: string | null;
  /** Delegated navigation to the run detail page (keeps this component router-free). */
  onOpenRun: (run: WorkflowRun) => void;
  /** Optional pagination — omit to hide the pager. */
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

/** Small icon matching the trigger type, mirroring the workflow card. */
function triggerIcon(trigger: WorkflowTriggerType) {
  switch (trigger) {
    case 'manual':
      return <TouchAppIcon fontSize="small" />;
    case 'on_media_enriched':
      return <AutoAwesomeIcon fontSize="small" />;
    case 'scheduled':
      return <ScheduleIcon fontSize="small" />;
    default:
      return undefined;
  }
}

function WorkflowRunRow({
  run,
  onOpenRun,
}: {
  run: WorkflowRun;
  onOpenRun: (run: WorkflowRun) => void;
}) {
  return (
    <Card variant="outlined">
      <CardActionArea
        onClick={() => onOpenRun(run)}
        sx={{ p: 1.5 }}
        aria-label={`Open run from ${formatRelativeTime(run.createdAt)}`}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 1,
          }}
        >
          {/* Trigger badge */}
          <Chip
            size="small"
            variant="outlined"
            icon={triggerIcon(run.triggerType)}
            label={triggerLabel(run.triggerType)}
          />

          {/* Status chip */}
          <Chip
            size="small"
            color={runStatusColor(run.status)}
            label={runStatusLabel(run.status)}
          />

          {/* Counts */}
          <Typography variant="caption" color="text.secondary">
            Matched {formatCount(run.matchedCount)}
            {run.truncated && ' (truncated)'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            ✓{formatCount(run.succeededCount)} ✗{formatCount(run.failedCount)}
          </Typography>

          {/* Relative created time, pushed to the right */}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ ml: { sm: 'auto' } }}
          >
            {formatRelativeTime(run.createdAt)}
          </Typography>
        </Box>
      </CardActionArea>
    </Card>
  );
}

export function WorkflowRunHistory({
  runs,
  isLoading,
  error,
  onOpenRun,
  page,
  totalPages,
  onPageChange,
}: WorkflowRunHistoryProps) {
  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  if (runs.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        <HistoryIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
        <Typography variant="body1" color="text.secondary">
          No runs yet
        </Typography>
        <Typography variant="caption" color="text.disabled">
          Runs appear here after this workflow is triggered manually, on new
          media, or on its schedule.
        </Typography>
      </Box>
    );
  }

  const showPager =
    typeof page === 'number' &&
    typeof totalPages === 'number' &&
    totalPages > 1 &&
    Boolean(onPageChange);

  return (
    <Stack spacing={1.5}>
      {runs.map((run) => (
        <WorkflowRunRow key={run.id} run={run} onOpenRun={onOpenRun} />
      ))}
      {showPager && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 1 }}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, next) => onPageChange?.(next)}
            size="small"
          />
        </Box>
      )}
    </Stack>
  );
}
