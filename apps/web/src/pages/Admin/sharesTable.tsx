/**
 * Public Sharing — the DataTable declaration and its query mapping (issue #259).
 *
 * Split out of `PublicSharesPage.tsx` for the same reason `jobsTable.tsx` was
 * split out of `JobsPage.tsx` (docs/specs/datatable.md §18): the column set and
 * the pure model → query-param mapping are the two halves worth testing in
 * isolation.
 *
 * ## The status tabs ARE the filter model
 *
 * Issue #259 decided the All / Active / Expired / Revoked tab strip stays — it
 * is the fastest control for the one triage question this page exists to answer.
 * So the tabs are not a second filter surface sitting beside the table's own:
 * they *write into the same normalized filter model* the DataTable is handed
 * ({@link withStatusFilter}), and the table reads the active tab back out of it
 * ({@link statusFromFilters}).
 *
 * The `status` column therefore deliberately declares **no `filterable`**. A
 * column that is filterable appears in the generic "Add filter" picker, and two
 * controls writing the same param is exactly the drift the old page had between
 * its tabs and its per-row state. The chip strip still shows the active status
 * filter, and removing that chip is the same gesture as selecting the "All" tab
 * — one model, one source of truth.
 *
 * `targetType` IS generically filterable: `GET /api/shares` accepts it, and no
 * bespoke control competes for it.
 *
 * ## The public URL never renders in full
 *
 * A share token is a bearer credential for the media behind it. The column
 * renders a truncated URL plus an explicit copy button (the only way to get the
 * whole thing), and is `exportable: false` so it can never leave the app through
 * a CSV — docs/specs/datatable.md §16.6.
 *
 * ## Nothing is `sortable`
 *
 * `GET /api/shares` takes no `sortBy`/`sortOrder`, so no column opts in and the
 * page passes no `sort` config, per the `sortable`-defaults-to-false rule (§4).
 */

import type { ReactNode } from 'react';
import { Avatar, Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CopyIcon from '@mui/icons-material/ContentCopy';
import ImageIcon from '@mui/icons-material/Image';
import AlbumIcon from '@mui/icons-material/PhotoLibrary';
import type {
  DataTableColumn,
  DataTableFilterModel,
} from '../../components/datatable';
import type { MediaShare, ShareStatus, ShareTargetType } from '../../types/sharing';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Persistence key for the user's column/density choices
 * (`user_settings.dataTables['admin-shares']`).
 */
export const SHARES_TABLE_ID = 'admin-shares';

/** The status-tab values. `'all'` is the absence of a status filter. */
export type ShareStatusFilter = 'all' | ShareStatus;

export const SHARE_STATUSES: ShareStatus[] = ['active', 'expired', 'revoked'];

const STATUS_COLORS: Record<ShareStatus, 'success' | 'warning' | 'error'> = {
  active: 'success',
  expired: 'warning',
  revoked: 'error',
};

const STATUS_LABELS: Record<ShareStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

const TARGET_LABELS: Record<ShareTargetType, string> = {
  media_item: 'Photo',
  album: 'Album',
};

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

function ShareStatusChip({ status }: { status: ShareStatus }) {
  return (
    <Chip
      label={STATUS_LABELS[status]}
      color={STATUS_COLORS[status]}
      size="small"
      variant="outlined"
    />
  );
}

export function formatShareDate(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

function formatShareDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

/** Clip a share URL for display. The full value is only ever reachable via copy. */
export function truncateShareUrl(url: string, maxLen = 32): string {
  if (url.length <= maxLen) return url;
  return `${url.slice(0, maxLen)}…`;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface ShareColumnHandlers {
  /** Copies the share's public URL. Wired to the in-cell copy button. */
  onCopy: (share: MediaShare) => void;
}

/** The first 8 characters of a share's record id — its human handle. */
export function shortShareId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The eight share columns.
 *
 * Priorities:
 *   - primary   — Share, Type, Status  (a card leads with "a1b2c3d4 Album Revoked")
 *   - secondary — Preview, Items, Public URL, Expires
 *   - detail    — Created
 *
 * `Share` leads deliberately: the first `primary` column is what names every
 * per-row control ("Select a1b2c3d4", "Row actions for a1b2c3d4",
 * docs/specs/datatable.md §17.6), and it is the only column here with
 * row-unique values — naming twenty checkboxes "Photo" would make the table
 * unnavigable by screen reader. It is the share RECORD id (what the bulk
 * endpoint takes), never the token.
 */
export function buildShareColumns({
  onCopy,
}: ShareColumnHandlers): DataTableColumn<MediaShare>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'id',
      label: 'Share',
      priority: 'primary',
      value: (share) => shortShareId(share.id),
      render: (share) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {shortShareId(share.id)}
        </Typography>
      ),
      width: 120,
      hideable: false,
    },
    {
      id: 'targetType',
      label: 'Type',
      priority: 'primary',
      value: (share) => TARGET_LABELS[share.targetType],
      render: (share) => (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          {share.targetType === 'album' ? (
            <AlbumIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          ) : (
            <ImageIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          )}
          <Typography variant="body2">{TARGET_LABELS[share.targetType]}</Typography>
        </Stack>
      ),
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [
        { value: 'media_item', label: 'Photo' },
        { value: 'album', label: 'Album' },
      ],
      width: 130,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (share) => share.status,
      render: (share) => <ShareStatusChip status={share.status} />,
      // Deliberately NOT `filterable`: the tab strip owns this filter (see the
      // module docblock). `filterType`/`enumValues` are still declared so the
      // chip the tabs produce reads "Status is Active", not "status is active".
      filterType: 'enum',
      enumValues: SHARE_STATUSES.map((status) => ({
        value: status,
        label: STATUS_LABELS[status],
      })),
      width: 120,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'preview',
      label: 'Preview',
      priority: 'secondary',
      // A thumbnail has no scalar worth writing to a CSV.
      exportable: false,
      render: (share) =>
        share.preview?.thumbnailUrl ? (
          <Avatar
            src={share.preview.thumbnailUrl}
            alt=""
            variant="rounded"
            sx={{ width: 40, height: 40 }}
          />
        ) : (
          <Avatar
            variant="rounded"
            sx={{ width: 40, height: 40, bgcolor: 'action.disabledBackground' }}
          >
            {share.targetType === 'album' ? (
              <AlbumIcon sx={{ fontSize: 20, color: 'text.disabled' }} />
            ) : (
              <ImageIcon sx={{ fontSize: 20, color: 'text.disabled' }} />
            )}
          </Avatar>
        ),
      width: 90,
      hideable: true,
    },
    {
      id: 'itemCount',
      label: 'Items',
      priority: 'secondary',
      align: 'right',
      value: (share) =>
        share.targetType === 'album' && share.itemCount != null ? share.itemCount : null,
      width: 90,
    },
    {
      id: 'publicUrl',
      label: 'Public URL',
      priority: 'secondary',
      // NEVER exported: the token in this URL is a bearer credential for the
      // media behind it (docs/specs/datatable.md §16.6).
      exportable: false,
      render: (share) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{ fontFamily: 'monospace', fontSize: '0.75rem', minWidth: 0 }}
            noWrap
          >
            {truncateShareUrl(share.publicUrl)}
          </Typography>
          <Tooltip title="Copy link">
            <IconButton
              size="small"
              aria-label={`Copy link for ${TARGET_LABELS[share.targetType]} share`}
              onClick={() => onCopy(share)}
            >
              <CopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      ),
      minWidth: 220,
      flex: 1.2,
    },
    {
      id: 'expiresAt',
      label: 'Expires',
      priority: 'secondary',
      value: (share) => share.expiresAt,
      render: (share) => (
        <Typography variant="body2" noWrap>
          {formatShareDate(share.expiresAt)}
        </Typography>
      ),
      minWidth: 170,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'detail',
      value: (share) => share.createdAt,
      render: (share) => (
        <Typography variant="body2" noWrap>
          {formatShareDateShort(share.createdAt)}
        </Typography>
      ),
      minWidth: 130,
    },
  ];
}

/** The empty-state node, shared by the page and its tests. */
export const SHARES_EMPTY_STATE: ReactNode = <span>No shares found.</span>;

// ---------------------------------------------------------------------------
// Model ⇄ status tab
// ---------------------------------------------------------------------------

/** Read the active status tab back out of the filter model. */
export function statusFromFilters(model: DataTableFilterModel): ShareStatusFilter {
  for (let index = model.length - 1; index >= 0; index -= 1) {
    const filter = model[index];
    if (filter.columnId !== 'status' || filter.operator !== 'is') continue;
    const raw = Array.isArray(filter.value) ? filter.value[0] : filter.value;
    const value = raw == null ? '' : String(raw);
    if ((SHARE_STATUSES as string[]).includes(value)) return value as ShareStatus;
  }
  return 'all';
}

/**
 * Write a status tab selection into the model.
 *
 * `'all'` REMOVES the status entry rather than encoding an "all" value — the
 * absence of the filter is what the endpoint means by "every status", exactly
 * as `processedWithin` handles it on the job queue (§18.1).
 */
export function withStatusFilter(
  model: DataTableFilterModel,
  status: ShareStatusFilter,
): DataTableFilterModel {
  const withoutStatus = model.filter((filter) => filter.columnId !== 'status');
  if (status === 'all') return withoutStatus;
  return [...withoutStatus, { columnId: 'status', operator: 'is', value: status }];
}

// ---------------------------------------------------------------------------
// Model → query params
// ---------------------------------------------------------------------------

/** The subset of `useMediaShares` params the filter model produces. */
export interface ShareFilterQuery {
  status?: ShareStatus;
  targetType?: ShareTargetType;
}

/**
 * Reduce an emitted model to one this endpoint can answer: at most one filter
 * per column, last one wins (every param here is single-valued).
 */
export function normalizeShareFilters(model: DataTableFilterModel): DataTableFilterModel {
  const claimed = new Set<string>();
  const out: DataTableFilterModel = [];
  for (let index = model.length - 1; index >= 0; index -= 1) {
    const filter = model[index];
    if (claimed.has(filter.columnId)) continue;
    claimed.add(filter.columnId);
    out.unshift(filter);
  }
  return out.length === model.length ? model : out;
}

/**
 * Map the normalized filter model onto `GET /api/shares` query params.
 *
 * Unknown columns, operators and enum values are ignored rather than forwarded:
 * a filter restored from a stale URL should drop, not produce a 400.
 */
export function toShareQuery(model: DataTableFilterModel): ShareFilterQuery {
  const query: ShareFilterQuery = {};

  for (const filter of model) {
    if (filter.operator !== 'is') continue;
    const raw = Array.isArray(filter.value) ? filter.value[0] : filter.value;
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw);

    switch (filter.columnId) {
      case 'status':
        if ((SHARE_STATUSES as string[]).includes(value)) query.status = value as ShareStatus;
        break;
      case 'targetType':
        if (value === 'media_item' || value === 'album') query.targetType = value;
        break;
      default:
        break;
    }
  }

  return query;
}
