/**
 * Admin → Operations → Broadcasts: the DataTable column contract. Epic #481,
 * issue #488 (ported from the reference implementation).
 *
 * A sibling module, like `jobsTable.tsx`: the column list is the table's public
 * shape — what a test, a CSV export and both renderers read — while the page
 * is the state that feeds it.
 *
 * `GET /api/admin/broadcasts` honours only `status` and `page`/`pageSize`, and
 * orders newest first. So NO column is `sortable` and there is no quick search:
 * a control that silently does nothing, or filters only the current page, lies
 * about its scope.
 */

import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn, DataTableFilterModel } from '../../components/datatable';
import { BROADCAST_RECHECK_INTERVAL, BROADCAST_STATUSES, channelLabel } from '../../services/broadcasts';
import type { Broadcast, BroadcastStatus } from '../../services/broadcasts';

/** Persistence key for `user_settings.dataTables`. A storage key: never rename. */
export const TABLE_ID = 'admin-broadcasts';

export const TITLE_COLUMN_ID = 'title';
export const STATUS_COLUMN_ID = 'status';

const STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  canceled: 'Canceled',
  failed: 'Failed',
};

export function statusLabel(status: BroadcastStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const STATUS_ENUM_VALUES = BROADCAST_STATUSES.map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

export const STATUS_CHIP_COLOR: Record<
  BroadcastStatus,
  'default' | 'info' | 'warning' | 'success' | 'error'
> = {
  draft: 'default',
  scheduled: 'info',
  sending: 'warning',
  sent: 'success',
  canceled: 'default',
  failed: 'error',
};

export function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A user reference as a readable name — never an object interpolated into text. */
export function userLabel(user: Broadcast['createdBy']): string {
  if (!user) return '—';
  return user.displayName ? `${user.displayName} (${user.email})` : user.email;
}

/**
 * `processed / recipients`. The denominator is `—` until the fan-out freezes
 * and counts the audience: `0 / 0` would read as "this reaches nobody".
 */
export function formatProgress(
  broadcast: Pick<Broadcast, 'processedCount' | 'recipientCount'>,
): string {
  const target = broadcast.recipientCount;
  return `${broadcast.processedCount.toLocaleString()} / ${target === null ? '—' : target.toLocaleString()}`;
}

/** 0–100, or `null` when there is no denominator yet. */
export function progressPercent(
  broadcast: Pick<Broadcast, 'processedCount' | 'recipientCount'>,
): number | null {
  const target = broadcast.recipientCount;
  if (target === null) return null;
  if (target === 0) return 100;
  return Math.min(100, Math.round((broadcast.processedCount / target) * 100));
}

/** A single-operand `is` filter as a plain string (a scalar an effect can depend on). */
export function readIsFilter(filters: DataTableFilterModel, columnId: string): string | undefined {
  const found = filters.find((filter) => filter.columnId === columnId && filter.operator === 'is');
  return typeof found?.value === 'string' && found.value ? found.value : undefined;
}

export function asBroadcastStatus(value: string | undefined): BroadcastStatus | undefined {
  return BROADCAST_STATUSES.find((candidate) => candidate === value);
}

export function buildBroadcastColumns(): DataTableColumn<Broadcast>[] {
  return [
    {
      // The row's accessible name. The short id is in the scalar because a
      // title alone is not row-unique ("Planned maintenance tonight" gets sent
      // every few weeks), and every row-action button is named after it.
      id: TITLE_COLUMN_ID,
      label: 'Title',
      priority: 'primary',
      hideable: false,
      minWidth: 220,
      flex: 1.4,
      value: (broadcast) => `${broadcast.title} (${shortId(broadcast.id)})`,
      render: (broadcast) => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {broadcast.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {shortId(broadcast.id)}
          </Typography>
        </Stack>
      ),
    },
    {
      id: STATUS_COLUMN_ID,
      label: 'Status',
      priority: 'primary',
      filterable: ['is'],
      filterType: 'enum',
      enumValues: STATUS_ENUM_VALUES,
      width: 130,
      value: (broadcast) => broadcast.status,
      render: (broadcast) => (
        <Chip
          label={statusLabel(broadcast.status)}
          size="small"
          color={STATUS_CHIP_COLOR[broadcast.status]}
        />
      ),
    },
    {
      id: 'importance',
      label: 'Importance',
      priority: 'secondary',
      width: 150,
      value: (broadcast) => (broadcast.critical ? 'Cannot be muted' : 'Normal'),
      render: (broadcast) =>
        broadcast.critical ? (
          <Tooltip title="Critical: delivered to every inbox regardless of preferences.">
            <Chip label="Cannot be muted" size="small" color="warning" variant="outlined" />
          </Tooltip>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Normal
          </Typography>
        ),
    },
    {
      id: 'channels',
      label: 'Channels',
      priority: 'secondary',
      minWidth: 170,
      value: (broadcast) => broadcast.channels.map(channelLabel).join(', '),
      render: (broadcast) => (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {broadcast.channels.map((channel) => (
            <Chip key={channel} label={channelLabel(channel)} size="small" variant="outlined" />
          ))}
        </Stack>
      ),
    },
    {
      id: 'scheduledFor',
      label: 'Scheduled for',
      priority: 'secondary',
      minWidth: 170,
      // `null` means "immediately", not "unknown" — an em dash would read as the latter.
      value: (broadcast) =>
        broadcast.scheduledFor ? formatDateTime(broadcast.scheduledFor) : 'Immediately',
    },
    {
      id: 'progress',
      label: 'Progress',
      priority: 'secondary',
      align: 'right',
      width: 140,
      value: (broadcast) => formatProgress(broadcast),
    },
    {
      id: 'finishedAt',
      label: 'Finished',
      priority: 'secondary',
      minWidth: 170,
      value: (broadcast) => formatDateTime(broadcast.finishedAt),
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'secondary',
      minWidth: 170,
      value: (broadcast) => formatDateTime(broadcast.createdAt),
    },
    {
      id: 'createdBy',
      label: 'Created by',
      priority: 'detail',
      minWidth: 160,
      value: (broadcast) => userLabel(broadcast.createdBy),
    },
    {
      id: 'lastError',
      label: 'Last error',
      priority: 'detail',
      truncate: true,
      minWidth: 220,
      value: (broadcast) => broadcast.lastError ?? '',
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (broadcast) => broadcast.id,
    },
  ];
}

// =============================================================================
// Action confirmation copy — shared by the row actions and the detail dialog
// =============================================================================

/**
 * The cancel confirmation. For a `sending` broadcast the in-flight sentence is
 * the point: the fan-out re-checks status BETWEEN chunks, so up to one chunk
 * may still go out — named as a number, because "some may still be sent"
 * reads like the cancel failed.
 */
export function cancelDescription(broadcast: Broadcast): string {
  if (broadcast.status === 'sending') {
    return (
      `"${broadcast.title}" is already sending. Cancelling stops the fan-out within the next ` +
      `${BROADCAST_RECHECK_INTERVAL} recipients, so up to that many more may still receive it — ` +
      'what has already been delivered cannot be recalled. The record is kept.'
    );
  }
  if (broadcast.status === 'failed') {
    return (
      `"${broadcast.title}" stopped after ${broadcast.processedCount} of ` +
      `${broadcast.recipientCount ?? 'an uncounted number of'} recipients. ` +
      'Cancelling means it will not be resumed; the record is kept.'
    );
  }
  return `"${broadcast.title}" will not be sent. The record is kept so you can see what was scheduled.`;
}

/** The resume confirmation: the failed chunk re-runs, so up to one chunk may get it twice. */
export function resumeDescription(broadcast: Broadcast): string {
  return (
    `"${broadcast.title}" stopped after ${broadcast.processedCount} of ` +
    `${broadcast.recipientCount ?? 'an uncounted number of'} recipients. Resuming continues from ` +
    `where it stopped, to the same audience. Up to ${BROADCAST_RECHECK_INTERVAL} recipients near the ` +
    'stopping point may receive it twice.'
  );
}

export function deleteDescription(broadcast: Broadcast): string {
  return (
    `"${broadcast.title}" will be removed from this list. Notifications already delivered are ` +
    'NOT withdrawn — recipients keep them. This cannot be undone.'
  );
}
