/**
 * Storage Providers — the two DataTable declarations for
 * `/admin/settings/storage/providers` (issue #259).
 *
 *   - {@link buildStorageProviderColumns} — one row per configurable provider
 *     (`admin-storage-providers`)
 *   - {@link MIGRATION_RUN_COLUMNS} — the copy-migration run history
 *     (`admin-storage-migrations`)
 *
 * ## Status is `primary` on both
 *
 * Issue #259's decision. For a provider that is the four-way
 * Active / Enabled / Disabled / Not configured state ({@link providerState});
 * for a run it is the server's own `status` enum. Both lead the card on a phone.
 *
 * ## The secret is never exported
 *
 * The API only ever returns the last four characters of a stored secret, and
 * even that is `exportable: false` — a masked credential fragment has no
 * business in a spreadsheet in a Downloads folder
 * (docs/specs/datatable.md §16.6).
 */

import { Box, Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import type { MigrationRun, StorageProviderRow } from '../../services/storage-providers';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const STORAGE_PROVIDERS_TABLE_ID = 'admin-storage-providers';
export const STORAGE_MIGRATIONS_TABLE_ID = 'admin-storage-migrations';

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

/** Human-readable provider label. Unknown keys fall back to their uppercase id. */
export function providerLabel(key: string): string {
  switch (key) {
    case 's3':
      return 'AWS S3';
    case 'r2':
      return 'Cloudflare R2';
    case 'local':
      return 'Local Disk';
    default:
      return key.toUpperCase();
  }
}

export type ProviderState = 'Active' | 'Enabled' | 'Disabled' | 'Not configured';

/**
 * The one question this table exists to answer, in priority order: is this the
 * provider new uploads go to, is it usable at all, and is it even set up?
 */
export function providerState(
  row: StorageProviderRow,
  activeProvider: string | undefined,
): ProviderState {
  if (row.provider === activeProvider) return 'Active';
  if (!row.configured) return 'Not configured';
  return row.enabled ? 'Enabled' : 'Disabled';
}

const PROVIDER_STATE_COLORS: Record<ProviderState, 'primary' | 'success' | 'default'> = {
  Active: 'primary',
  Enabled: 'success',
  Disabled: 'default',
  'Not configured': 'default',
};

/** The masked secret the API exposes, or an em dash. */
export function maskedSecret(row: StorageProviderRow): string | null {
  return row.last4 ? `••••••••${row.last4}` : null;
}

// ---------------------------------------------------------------------------
// Provider columns
// ---------------------------------------------------------------------------

/**
 * The seven provider columns.
 *
 * Priorities:
 *   - primary   — Provider, Status
 *   - secondary — Bucket, Region
 *   - detail    — Endpoint, Secret, Updated
 *
 * @param activeProvider the `storage.activeProvider` system setting, which is
 *   what makes one row's status "Active" rather than merely "Enabled".
 */
export function buildStorageProviderColumns(
  activeProvider: string | undefined,
): DataTableColumn<StorageProviderRow>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'provider',
      label: 'Provider',
      priority: 'primary',
      value: (row) => providerLabel(row.provider),
      minWidth: 160,
      flex: 1,
    },
    {
      id: 'state',
      label: 'Status',
      priority: 'primary',
      value: (row) => providerState(row, activeProvider),
      render: (row) => {
        const state = providerState(row, activeProvider);
        return (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
            <Chip
              label={state}
              color={PROVIDER_STATE_COLORS[state]}
              size="small"
              variant={state === 'Active' ? 'filled' : 'outlined'}
            />
            {row.configured && (
              <Chip label="Configured" color="info" size="small" variant="outlined" />
            )}
          </Box>
        );
      },
      minWidth: 190,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'bucket',
      label: 'Bucket',
      priority: 'secondary',
      value: (row) => row.bucket,
      truncate: true,
      minWidth: 150,
    },
    {
      id: 'region',
      label: 'Region',
      priority: 'secondary',
      value: (row) => row.region,
      width: 130,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'endpoint',
      label: 'Endpoint',
      priority: 'detail',
      value: (row) => row.endpoint,
      truncate: true,
      minWidth: 200,
      flex: 1,
    },
    {
      id: 'last4',
      label: 'Secret',
      priority: 'detail',
      // Never leaves the app through a CSV, masked or not.
      exportable: false,
      value: (row) => maskedSecret(row),
      render: (row) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }} color="text.secondary">
          {maskedSecret(row) ?? '—'}
        </Typography>
      ),
      width: 150,
    },
    {
      id: 'updatedAt',
      label: 'Updated',
      priority: 'detail',
      value: (row) => row.updatedAt ?? null,
      render: (row) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—'}
        </Typography>
      ),
      minWidth: 160,
    },
  ];
}

// ---------------------------------------------------------------------------
// Migration run columns
// ---------------------------------------------------------------------------

const RUN_STATUS_COLORS: Record<string, 'default' | 'warning' | 'info' | 'success' | 'error'> = {
  pending: 'warning',
  running: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

/** The migration-status chip, shared with the in-flight progress panel. */
export function MigrationStatusChip({ status }: { status: string }) {
  return (
    <Chip
      label={status}
      color={RUN_STATUS_COLORS[status] ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

/** `"Local Disk → AWS S3"` — the scalar behind the Route column. */
export function migrationRoute(run: MigrationRun): string {
  return `${providerLabel(run.sourceProvider)} → ${providerLabel(run.targetProvider)}`;
}

/**
 * The seven run columns.
 *
 * Priorities:
 *   - primary   — Route, Status
 *   - secondary — Copied, Failed
 *   - detail    — Skipped, Started, Finished
 */
export const MIGRATION_RUN_COLUMNS: DataTableColumn<MigrationRun>[] = [
  // --- primary --------------------------------------------------------------
  {
    id: 'route',
    label: 'Route',
    priority: 'primary',
    value: migrationRoute,
    render: (run) => (
      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }} noWrap>
        {migrationRoute(run)}
      </Typography>
    ),
    minWidth: 200,
    flex: 1,
  },
  {
    id: 'status',
    label: 'Status',
    priority: 'primary',
    value: (run) => run.status,
    render: (run) => <MigrationStatusChip status={run.status} />,
    width: 130,
  },

  // --- secondary ------------------------------------------------------------
  {
    id: 'migratedCount',
    label: 'Copied',
    priority: 'secondary',
    align: 'right',
    value: (run) => run.migratedCount,
    width: 100,
  },
  {
    id: 'failedCount',
    label: 'Failed',
    priority: 'secondary',
    align: 'right',
    value: (run) => run.failedCount,
    render: (run) => (
      <Chip
        label={run.failedCount}
        size="small"
        color={run.failedCount > 0 ? 'error' : 'default'}
        variant="outlined"
      />
    ),
    width: 100,
  },

  // --- detail ---------------------------------------------------------------
  {
    id: 'skippedCount',
    label: 'Skipped',
    priority: 'detail',
    align: 'right',
    value: (run) => run.skippedCount,
    width: 110,
  },
  {
    id: 'startedAt',
    label: 'Started',
    priority: 'detail',
    value: (run) => run.startedAt,
    render: (run) => (
      <Typography variant="body2" noWrap>
        {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
      </Typography>
    ),
    minWidth: 180,
  },
  {
    id: 'finishedAt',
    label: 'Finished',
    priority: 'detail',
    value: (run) => run.finishedAt,
    render: (run) => (
      <Typography variant="body2" noWrap>
        {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}
      </Typography>
    ),
    minWidth: 180,
  },
];
