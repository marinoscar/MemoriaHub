/**
 * User Management → Users — the DataTable declaration and its query mapping
 * (issue #260, epic #238).
 *
 * Split out of `UserList.tsx` exactly as `jobsTable.tsx` was split out of
 * `JobsPage.tsx` (docs/specs/datatable.md §18): the column set and the pure
 * model → query-param mapping are the two halves worth testing in isolation,
 * and the page keeps only its server state and its mutations.
 *
 * ## Why Status and Roles are `primary`
 *
 * This is an identity-and-access table: "can this person get in, and what can
 * they do" is the thing an operator scans for, not a detail they drill into. So
 * `email` (identity — and therefore the card headline / accessible name),
 * `isActive` and `roles` are all `primary` and lead the card; the display name,
 * the created date and the id fold below.
 *
 * ## What the endpoint can actually filter
 *
 * `GET /api/users` accepts `search`, `role` and `isActive` — nothing else. Both
 * filterable columns therefore pin `filterable: ['is']` (§18.3: the enum default
 * set is `is`/`isNot`/`isAnyOf`, and this endpoint can express neither of the
 * other two), and no column is `sortable` because the endpoint takes no
 * `sortBy`/`sortOrder`.
 *
 * ## Nothing here is permission-gated
 *
 * The row actions are, and they are declared by the page (`UserList.tsx`) rather
 * than here, because whether the caller may deactivate a user or change roles is
 * a property of the CALLER, not of the column set. This module is pure and takes
 * no permissions.
 */

import { Avatar, Box, Chip, Stack, Typography } from '@mui/material';
import type { DataTableColumn, DataTableFilterModel } from '../datatable';
import type { UserListItem } from '../../types';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Persistence key for the user's column/density choices
 * (`user_settings.dataTables['admin-users']`). Chosen here, never derived from
 * the route — it must survive a URL change.
 */
export const USERS_TABLE_ID = 'admin-users';

/** The roles the RBAC model exposes for assignment (see CLAUDE.md → RBAC). */
export const AVAILABLE_ROLES = ['admin', 'contributor', 'viewer'] as const;

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** Effective display name: the custom override, else the provider's, else "—". */
export function userDisplayName(user: UserListItem): string {
  return user.displayName || user.providerDisplayName || 'No name';
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function buildUserColumns(): DataTableColumn<UserListItem>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'email',
      label: 'User',
      priority: 'primary',
      // The scalar is the email, so the card headline, the per-row control
      // labels ("Row actions for alice@example.com") and a CSV export all read
      // the one field that is unique per row.
      value: (user) => user.email,
      render: (user) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Avatar
            src={user.profileImageUrl || undefined}
            alt={user.email}
            sx={{ width: 32, height: 32, flexShrink: 0 }}
          >
            {user.email[0]?.toUpperCase()}
          </Avatar>
          <Typography variant="body2" noWrap>
            {user.email}
          </Typography>
        </Box>
      ),
      searchable: true,
      minWidth: 240,
      flex: 1.4,
    },
    {
      id: 'isActive',
      label: 'Status',
      priority: 'primary',
      value: (user) => (user.isActive ? 'Active' : 'Inactive'),
      render: (user) =>
        user.isActive ? (
          <Chip label="Active" color="success" size="small" />
        ) : (
          <Chip label="Inactive" color="error" size="small" />
        ),
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
      width: 130,
    },
    {
      id: 'roles',
      label: 'Roles',
      priority: 'primary',
      value: (user) => user.roles.join(', '),
      render: (user) => (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {user.roles.map((role) => (
            <Chip key={role} label={role} size="small" />
          ))}
        </Stack>
      ),
      // `role=` is single-valued server-side, so `is` is the only operator this
      // endpoint can answer.
      filterable: ['is'],
      filterType: 'enum',
      enumValues: AVAILABLE_ROLES.map((role) => ({ value: role, label: role })),
      minWidth: 180,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'displayName',
      label: 'Display name',
      priority: 'secondary',
      value: userDisplayName,
      searchable: true,
      minWidth: 170,
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'secondary',
      value: (user) => user.createdAt,
      render: (user) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(user.createdAt)}
        </Typography>
      ),
      minWidth: 130,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'id',
      label: 'User ID',
      priority: 'detail',
      value: (user) => user.id,
      render: (user) => (
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {user.id}
        </Typography>
      ),
      truncate: true,
      minWidth: 160,
    },
  ];
}

// ---------------------------------------------------------------------------
// Model → query params
// ---------------------------------------------------------------------------

/** The subset of `getUsers`' params the filter model produces. */
export interface UserFilterQuery {
  role?: string;
  isActive?: boolean;
}

/**
 * Reduce an emitted model to one this endpoint can answer: at most one filter
 * per column, last one wins.
 *
 * Every param here is single-valued, so a second `role` filter could only
 * shadow the first. Because `filters` is controlled, the normalized model is
 * what the chip strip renders — the superseded filter visibly disappears rather
 * than lingering as a chip with no effect on the query (§18.2).
 */
export function normalizeUserFilters(model: DataTableFilterModel): DataTableFilterModel {
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
 * Map the normalized filter model onto `GET /api/users` query params.
 *
 * Pure. Unknown columns, unknown operators and unrecognized enum values are
 * ignored rather than forwarded — a filter restored from a stale URL should
 * drop, not produce a 400.
 */
export function toUserQuery(model: DataTableFilterModel): UserFilterQuery {
  const query: UserFilterQuery = {};

  for (const filter of model) {
    if (filter.operator !== 'is') continue;
    const raw = Array.isArray(filter.value) ? filter.value[0] : filter.value;
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw);

    switch (filter.columnId) {
      case 'isActive':
        if (value === 'true' || value === 'false') query.isActive = value === 'true';
        break;
      case 'roles':
        if ((AVAILABLE_ROLES as readonly string[]).includes(value)) query.role = value;
        break;
      default:
        break;
    }
  }

  return query;
}
