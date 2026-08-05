/**
 * User Management → Allowlist — the DataTable declaration and its query mapping
 * (issue #260, epic #238).
 *
 * The allowlist is the app's front door: an entry here is the difference
 * between a Google account that can sign in and one that cannot. Two
 * consequences shape this column set.
 *
 * **Status is `primary`.** Pending vs. Claimed is the thing an operator scans
 * for — a Pending row is an invitation nobody has used yet, a Claimed row is a
 * live user's access — so it leads the card beside the email rather than
 * hiding behind "More details".
 *
 * **Claimed entries are not removable.** That rule predates this migration and
 * is preserved verbatim: `DELETE /api/allowlist/{id}` on a claimed entry would
 * revoke an existing user's access by accident. It lives on the row action's
 * `disabled` predicate (`AllowlistTable.tsx`), which both renderers honour —
 * the grid disables the icon button, the card disables the menu item.
 *
 * `GET /api/allowlist` accepts `search` and `status` (`all|pending|claimed`)
 * and nothing else, so `status` pins `filterable: ['is']` (§18.3) and no column
 * is `sortable` — the endpoint takes no sort param.
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn, DataTableFilterModel } from '../datatable';
import type { AllowedEmailEntry } from '../../types';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Persistence key for `user_settings.dataTables['admin-allowlist']`. */
export const ALLOWLIST_TABLE_ID = 'admin-allowlist';

/** The one rule this table exists to protect. */
export function isClaimed(entry: AllowedEmailEntry): boolean {
  return Boolean(entry.claimedBy);
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function buildAllowlistColumns(): DataTableColumn<AllowedEmailEntry>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'email',
      label: 'Email',
      priority: 'primary',
      value: (entry) => entry.email,
      searchable: true,
      minWidth: 240,
      flex: 1.4,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (entry) => (isClaimed(entry) ? 'Claimed' : 'Pending'),
      render: (entry) =>
        isClaimed(entry) ? (
          <Chip label="Claimed" color="success" size="small" />
        ) : (
          <Chip label="Pending" color="warning" size="small" />
        ),
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [
        { value: 'pending', label: 'Pending' },
        { value: 'claimed', label: 'Claimed' },
      ],
      width: 130,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'addedBy',
      label: 'Added by',
      priority: 'secondary',
      value: (entry) => entry.addedBy?.email ?? 'System',
      minWidth: 200,
    },
    {
      id: 'addedAt',
      label: 'Added',
      priority: 'secondary',
      value: (entry) => entry.addedAt,
      render: (entry) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDateTime(entry.addedAt)}
        </Typography>
      ),
      minWidth: 180,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'notes',
      label: 'Notes',
      priority: 'detail',
      value: (entry) => entry.notes,
      // One line + tooltip on the grid; tap-to-expand on a card. A free-text
      // note is exactly the column that otherwise blows a row up to five lines.
      truncate: true,
      minWidth: 200,
      flex: 2,
    },
    {
      id: 'claimedBy',
      label: 'Claimed by',
      priority: 'detail',
      value: (entry) => entry.claimedBy?.email ?? null,
      minWidth: 200,
    },
    {
      id: 'claimedAt',
      label: 'Claimed at',
      priority: 'detail',
      value: (entry) => entry.claimedAt,
      render: (entry) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDateTime(entry.claimedAt)}
        </Typography>
      ),
      minWidth: 180,
    },
  ];
}

// ---------------------------------------------------------------------------
// Model → query params
// ---------------------------------------------------------------------------

export interface AllowlistFilterQuery {
  status?: 'pending' | 'claimed';
}

/** At most one filter per column, last one wins — every param is single-valued. */
export function normalizeAllowlistFilters(
  model: DataTableFilterModel,
): DataTableFilterModel {
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
 * Map the normalized filter model onto `GET /api/allowlist` query params.
 *
 * The API's `status=all` is the ABSENCE of a filter, so it is never emitted as
 * a value — same reasoning as the job queue's `processedWithin` (§18.1).
 */
export function toAllowlistQuery(model: DataTableFilterModel): AllowlistFilterQuery {
  const query: AllowlistFilterQuery = {};

  for (const filter of model) {
    if (filter.operator !== 'is') continue;
    if (filter.columnId !== 'status') continue;
    const raw = Array.isArray(filter.value) ? filter.value[0] : filter.value;
    const value = raw === null || raw === undefined ? '' : String(raw);
    if (value === 'pending' || value === 'claimed') query.status = value;
  }

  return query;
}
