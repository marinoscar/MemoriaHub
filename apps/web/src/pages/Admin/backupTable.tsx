/**
 * Admin Backup — the run-history DataTable declaration (issue #259).
 *
 * ## Status is derived, and it is `primary`
 *
 * `GET /api/admin/backup/runs` returns no status field — a run is described by
 * its counters and its timestamps. The one question an operator scans this list
 * for ("did it work?") is therefore computed here, once, in
 * {@link backupRunStatus}, rather than being re-derived by every reader:
 *
 *   - `failed > 0`        → **Failed**
 *   - no `completedAt`    → **Running**
 *   - otherwise           → **Succeeded**
 *
 * Issue #259 decided this leads the card on a phone, so it is a `primary`
 * column beside the scope.
 *
 * ## No pagination, sort or filter
 *
 * The endpoint returns the recent runs as a plain array with no query params, so
 * none of the three server-side controls is declared (§4).
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import type { BackupRun } from '../../services/backup';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const BACKUP_RUNS_TABLE_ID = 'admin-backup-runs';

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

export type BackupRunStatus = 'Succeeded' | 'Failed' | 'Running';

export function backupRunStatus(run: BackupRun): BackupRunStatus {
  if (run.failed > 0) return 'Failed';
  if (!run.completedAt) return 'Running';
  return 'Succeeded';
}

const STATUS_COLORS: Record<BackupRunStatus, 'success' | 'error' | 'info'> = {
  Succeeded: 'success',
  Failed: 'error',
  Running: 'info',
};

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * The seven run columns.
 *
 * Priorities:
 *   - primary   — Scope, Status
 *   - secondary — Copied, Failed, Started At
 *   - detail    — Skipped, Completed
 */
export const BACKUP_RUN_COLUMNS: DataTableColumn<BackupRun>[] = [
  // --- primary --------------------------------------------------------------
  {
    id: 'scope',
    label: 'Scope',
    priority: 'primary',
    value: (run) => run.scope,
    render: (run) => (
      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }} noWrap>
        {run.scope}
      </Typography>
    ),
    minWidth: 160,
    flex: 1,
  },
  {
    id: 'status',
    label: 'Status',
    priority: 'primary',
    value: backupRunStatus,
    render: (run) => {
      const status = backupRunStatus(run);
      return <Chip label={status} color={STATUS_COLORS[status]} size="small" variant="outlined" />;
    },
    width: 130,
  },

  // --- secondary ------------------------------------------------------------
  {
    id: 'copied',
    label: 'Copied',
    priority: 'secondary',
    align: 'right',
    value: (run) => run.copied,
    width: 100,
  },
  {
    id: 'failed',
    label: 'Failed',
    priority: 'secondary',
    align: 'right',
    value: (run) => run.failed,
    render: (run) => (
      <Chip label={run.failed} size="small" color={run.failed > 0 ? 'error' : 'success'} />
    ),
    width: 100,
  },
  {
    id: 'startedAt',
    label: 'Started At',
    priority: 'secondary',
    value: (run) => run.startedAt,
    render: (run) => (
      <Typography variant="body2" noWrap>
        {formatTimestamp(run.startedAt)}
      </Typography>
    ),
    minWidth: 180,
  },

  // --- detail ---------------------------------------------------------------
  {
    id: 'skipped',
    label: 'Skipped',
    priority: 'detail',
    align: 'right',
    value: (run) => run.skipped,
    width: 110,
  },
  {
    id: 'completedAt',
    label: 'Completed',
    priority: 'detail',
    value: (run) => run.completedAt ?? null,
    render: (run) => (
      <Typography variant="body2" noWrap>
        {formatTimestamp(run.completedAt)}
      </Typography>
    ),
    minWidth: 180,
  },
];
