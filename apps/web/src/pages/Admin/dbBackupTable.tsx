/**
 * Database Backup — the run-history DataTable declaration for
 * `/admin/settings/db-backup` (issue #345, epic #339).
 *
 * ## "verified" is a DERIVED chip, not a status
 *
 * The API's `DatabaseBackupStatus` enum has five members and `verified` is not
 * one of them — verification is a `verifiedAt` TIMESTAMP written after the
 * uploaded archive is streamed back through `pg_restore --list`. A `completed`
 * run with no `verifiedAt` and a `completed` run that passed verification are
 * materially different artifacts (one is a file, the other is a file known to
 * restore), so the chip distinguishes them while `value()` still returns the
 * real status the `?status=` filter accepts.
 *
 * ## `pre_restore` is visually distinguished
 *
 * A `pre_restore` row is a safety dump #344's restore flow takes on the user's
 * behalf, not something an admin scheduled or clicked. Rendering it in the same
 * neutral text as `manual`/`scheduled` would make an automatic side effect look
 * like an intentional backup, so it gets its own warning-toned chip.
 *
 * ## Sorting / filtering
 *
 * `GET /runs` supports `status`, `page`, and `pageSize` only — no `sortBy`. No
 * column declares `sortable`, since painting a control the server cannot honour
 * is exactly what docs/specs/datatable.md §4 forbids.
 */

import { Chip, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import type { DbBackupRunDto, DbBackupRunStatus } from '../../services/dbBackup';
import { formatBytes, formatDuration, relativeTime } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const DB_BACKUP_RUNS_TABLE_ID = 'admin-db-backup-runs';

// ---------------------------------------------------------------------------
// Display helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** The display state shown in the chip — the API status plus derived `verified`. */
export type DbBackupDisplayStatus = DbBackupRunStatus | 'verified';

/**
 * A `completed` run that carries a `verifiedAt` reads as `verified`; everything
 * else shows its real status verbatim.
 */
export function displayStatus(run: DbBackupRunDto): DbBackupDisplayStatus {
  if (run.status === 'completed' && run.verifiedAt) return 'verified';
  return run.status;
}

const STATUS_COLORS: Record<
  DbBackupDisplayStatus,
  'default' | 'info' | 'success' | 'warning' | 'error'
> = {
  pending: 'default',
  running: 'info',
  completed: 'success',
  verified: 'success',
  failed: 'error',
  stale: 'warning',
};

export function DbBackupStatusChip({ run }: { run: DbBackupRunDto }) {
  const display = displayStatus(run);
  const chip = (
    <Chip
      label={display}
      color={STATUS_COLORS[display] ?? 'default'}
      size="small"
      variant={display === 'verified' ? 'filled' : 'outlined'}
    />
  );

  if (display === 'verified') {
    return (
      <Tooltip title="The uploaded archive was streamed back through pg_restore --list and is readable">
        {chip}
      </Tooltip>
    );
  }
  if (display === 'completed') {
    return (
      <Tooltip title="Dump uploaded, but not verified — the archive has not been read back">
        {chip}
      </Tooltip>
    );
  }
  return chip;
}

/** `pre_restore` gets a warning chip; the two intentional triggers stay plain. */
export function DbBackupTriggerCell({ trigger }: { trigger: string }) {
  if (trigger === 'pre_restore') {
    return (
      <Tooltip title="Automatic safety dump taken immediately before a restore">
        <Chip label="pre-restore" color="warning" size="small" variant="outlined" />
      </Tooltip>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary" noWrap>
      {trigger}
    </Typography>
  );
}

/**
 * The size an admin cares about: the final `sizeBytes` once known, otherwise
 * the live `bytesWritten` of an in-flight dump. Both are BigInt-safe strings —
 * never coerced through `Number`.
 */
export function runSizeBytes(run: DbBackupRunDto): string {
  return run.sizeBytes ?? run.bytesWritten;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Priorities:
 *   - primary   — Status, Started, Size
 *   - secondary — Trigger, Finished, Duration, Provider
 *   - detail    — Checksum, DB version, Migration, Last error
 */
export function buildDbBackupRunColumns(): DataTableColumn<DbBackupRunDto>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (run) => run.status,
      render: (run) => <DbBackupStatusChip run={run} />,
      width: 130,
    },
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'primary',
      value: (run) => run.startedAt,
      render: (run) => (
        <Tooltip title={run.startedAt ? new Date(run.startedAt).toLocaleString() : ''}>
          <Typography variant="body2" color="text.secondary" noWrap>
            {run.startedAt ? relativeTime(run.startedAt) : '—'}
          </Typography>
        </Tooltip>
      ),
      minWidth: 130,
    },
    {
      id: 'size',
      label: 'Size',
      priority: 'primary',
      value: (run) => runSizeBytes(run),
      render: (run) => (
        <Typography variant="body2" noWrap>
          {formatBytes(runSizeBytes(run))}
        </Typography>
      ),
      width: 120,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'trigger',
      label: 'Trigger',
      priority: 'secondary',
      value: (run) => run.trigger,
      render: (run) => <DbBackupTriggerCell trigger={run.trigger} />,
      width: 130,
    },
    {
      id: 'finishedAt',
      label: 'Finished',
      priority: 'secondary',
      value: (run) => run.finishedAt,
      render: (run) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {run.finishedAt ? relativeTime(run.finishedAt) : '—'}
        </Typography>
      ),
      minWidth: 130,
    },
    {
      id: 'duration',
      label: 'Duration',
      priority: 'secondary',
      value: (run) => run.elapsedMs,
      render: (run) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDuration(run.elapsedMs)}
        </Typography>
      ),
      width: 120,
    },
    {
      id: 'storageProvider',
      label: 'Provider',
      priority: 'secondary',
      value: (run) => run.storageProvider,
      render: (run) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {run.storageProvider ?? '—'}
        </Typography>
      ),
      width: 120,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'checksumSha256',
      label: 'Checksum',
      priority: 'detail',
      value: (run) => run.checksumSha256,
      render: (run) =>
        run.checksumSha256 ? (
          <Tooltip title={run.checksumSha256}>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }} noWrap>
              {run.checksumSha256.slice(0, 12)}…
            </Typography>
          </Tooltip>
        ) : (
          <Typography variant="body2" color="text.disabled">
            —
          </Typography>
        ),
      minWidth: 140,
    },
    {
      id: 'dbVersion',
      label: 'DB version',
      priority: 'detail',
      value: (run) => run.dbVersion,
      width: 130,
    },
    {
      id: 'migrationName',
      label: 'Migration',
      priority: 'detail',
      value: (run) => run.migrationName,
      truncate: true,
      minWidth: 180,
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
