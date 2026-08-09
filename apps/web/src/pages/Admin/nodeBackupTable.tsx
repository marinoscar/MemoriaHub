/**
 * Node Backup — the runs-history DataTable declaration for
 * `/admin/settings/nodes/:id/backup` (issue #319, epic #308).
 *
 * ## Nothing is `sortable` or `filterable`
 *
 * `GET /nodes/:id/backup/runs?limit=20` returns the newest runs with no page,
 * sort, or filter params — declaring any of those would paint a control the
 * server cannot honour (docs/specs/datatable.md §4).
 *
 * ## `lastError` is a `detail` column
 *
 * On a phone/tablet it folds into the card/row expansion; on desktop it is a
 * truncated column revealing the full text on hover — the contract's own
 * "expansion/detail" surface, no bespoke drawer needed.
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import type {
  NodeBackupRunDto,
  NodeBackupRunStatus,
} from '../../services/nodeBackup';
import { formatBytes, formatDuration, relativeTime } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const NODE_BACKUP_RUNS_TABLE_ID = 'admin-node-backup-runs';

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

const RUN_STATUS_COLORS: Record<
  NodeBackupRunStatus,
  'default' | 'info' | 'success' | 'warning' | 'error'
> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  aborted: 'warning',
  stale: 'default',
};

function RunStatusChip({ status }: { status: NodeBackupRunStatus }) {
  return (
    <Chip
      label={status}
      color={RUN_STATUS_COLORS[status] ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

/** finishedAt - startedAt in ms; null while the run is still going. */
export function runDurationMs(run: NodeBackupRunDto): number | null {
  if (!run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * The backup-run history columns.
 *
 * Priorities:
 *   - primary   — Kind, Status
 *   - secondary — Trigger, Started, Duration, Items downloaded, Bytes, Errors
 *   - detail    — Items skipped, Last error
 */
export function buildNodeBackupRunColumns(): DataTableColumn<NodeBackupRunDto>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'kind',
      label: 'Kind',
      priority: 'primary',
      value: (run) => run.kind,
      width: 130,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (run) => run.status,
      render: (run) => <RunStatusChip status={run.status} />,
      width: 130,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'trigger',
      label: 'Trigger',
      priority: 'secondary',
      value: (run) => run.trigger,
      width: 120,
    },
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'secondary',
      value: (run) => run.startedAt,
      render: (run) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {relativeTime(run.startedAt)}
        </Typography>
      ),
      minWidth: 130,
    },
    {
      id: 'duration',
      label: 'Duration',
      priority: 'secondary',
      value: (run) => runDurationMs(run),
      render: (run) => {
        const ms = runDurationMs(run);
        return (
          <Typography variant="body2" color="text.secondary" noWrap>
            {ms === null ? '—' : formatDuration(ms)}
          </Typography>
        );
      },
      width: 120,
    },
    {
      id: 'itemsDownloaded',
      label: 'Downloaded',
      priority: 'secondary',
      align: 'center',
      value: (run) => run.itemsDownloaded,
      width: 130,
    },
    {
      id: 'bytesDownloaded',
      label: 'Bytes',
      priority: 'secondary',
      value: (run) => run.bytesDownloaded,
      render: (run) => (
        <Typography variant="body2" noWrap>
          {formatBytes(run.bytesDownloaded)}
        </Typography>
      ),
      width: 120,
    },
    {
      id: 'errorCount',
      label: 'Errors',
      priority: 'secondary',
      align: 'center',
      value: (run) => run.errorCount,
      render: (run) => (
        <Typography
          variant="body2"
          color={run.errorCount > 0 ? 'error.main' : 'text.secondary'}
        >
          {run.errorCount}
        </Typography>
      ),
      width: 100,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'itemsSkipped',
      label: 'Skipped',
      priority: 'detail',
      align: 'center',
      value: (run) => run.itemsSkipped,
      width: 110,
    },
    {
      id: 'lastError',
      label: 'Last error',
      priority: 'detail',
      value: (run) => run.lastError,
      render: (run) =>
        run.lastError ? (
          <Typography variant="body2" color="error.main">
            {run.lastError}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.disabled">
            —
          </Typography>
        ),
      truncate: true,
      minWidth: 220,
      flex: 1,
    },
  ];
}
