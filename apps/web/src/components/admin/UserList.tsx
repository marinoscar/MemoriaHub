/**
 * User Management → Users tab.
 *
 * Migrated onto the shared DataTable in issue #260 (epic #238). What that
 * deleted: a hand-rolled 6-column `<Table>`, its `TablePagination` footer, a
 * bespoke search `TextField`, and a two-level `Menu`/sub-`Menu` pair that was
 * the only route to "Deactivate user" — an unlabelled `MoreVert` button one tap
 * from a destructive, unconfirmed account change.
 *
 * Three things this migration is specifically responsible for (issue #260):
 *
 * 1. **Destructive actions confirm, and the confirmation names its target.**
 *    "Deactivate user?" → "alice@example.com will lose access…", not "Are you
 *    sure?". A card's overflow menu puts every action one tap away, so a
 *    mis-tap has to be recoverable by reading the dialog.
 * 2. **Status and roles lead the card.** Both are `primary` columns
 *    (`usersTable.tsx`), so a phone shows who / active / what-they-can-do
 *    without expanding anything.
 * 3. **Privileged actions are gated in BOTH renderers.** The action list is
 *    built from the caller's permissions, so an action the caller may not
 *    perform does not exist in the grid's menu, in the card's menu, or in the
 *    DOM at all. Gating the ARRAY rather than a renderer is what makes that
 *    true once instead of twice.
 *
 * The gates match the API's own RBAC: `users:write` for activation changes,
 * `rbac:manage` for role assignment (CLAUDE.md → Key Permissions). They can
 * only ever HIDE an action — the page itself is already behind `users:read`
 * (`UserManagementPage`), which is unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Paper,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import {
  Block as DeactivateIcon,
  CheckCircleOutlined as ActivateIcon,
  ManageAccounts as RolesIcon,
} from '@mui/icons-material';
import { useUsers } from '../../hooks/useUsers';
import { usePermissions } from '../../hooks/usePermissions';
import { DataTable, type DataTableFilterModel, type DataTableRowAction } from '../datatable';
import {
  AVAILABLE_ROLES,
  USERS_TABLE_ID,
  buildUserColumns,
  normalizeUserFilters,
  toUserQuery,
} from './usersTable';
import type { UserListItem } from '../../types';

const DEFAULT_PAGE_SIZE = 10;

export function UserList() {
  const { users, total, isLoading, error, fetchUsers, updateUser, updateUserRoles } =
    useUsers();
  const { hasPermission } = usePermissions();

  // Mirrors the API's RBAC. These can only remove an action from the list.
  const canWriteUsers = hasPermission('users:write');
  const canManageRoles = hasPermission('rbac:manage');

  // --- Controlled table state (all of it lives HERE, above the table) --------
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [filterModel, setFilterModel] = useState<DataTableFilterModel>([]);

  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [rolesTargetId, setRolesTargetId] = useState<string | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);

  // Destructured so the fetch effect depends on the two scalars the query
  // actually carries, not on a fresh object identity per render.
  const { role, isActive } = useMemo(() => toUserQuery(filterModel), [filterModel]);

  useEffect(() => {
    fetchUsers({
      page: page + 1, // the API is 1-based, the table 0-based
      pageSize,
      search: search || undefined,
      role,
      isActive,
    });
  }, [page, pageSize, search, role, isActive, fetchUsers]);

  const columns = useMemo(() => buildUserColumns(), []);

  // --- Mutations -------------------------------------------------------------

  const handleSetActive = useCallback(
    async (user: UserListItem, nextActive: boolean) => {
      setMutating(true);
      setActionError(null);
      try {
        await updateUser(user.id, { isActive: nextActive });
        setSuccessMessage(
          `${user.email} ${nextActive ? 'activated' : 'deactivated'}`,
        );
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : 'Failed to update user',
        );
      } finally {
        setMutating(false);
      }
    },
    [updateUser],
  );

  const rolesTarget = useMemo(
    () => users.find((user) => user.id === rolesTargetId) ?? null,
    [users, rolesTargetId],
  );

  const handleRoleToggle = useCallback(
    async (targetRole: string) => {
      if (!rolesTarget) return;
      const current = rolesTarget.roles;
      const next = current.includes(targetRole)
        ? current.filter((r) => r !== targetRole)
        : [...current, targetRole];

      // Preserved from the pre-migration component: a user must keep at least
      // one role. Surfaced inline rather than through `window.alert`, which is
      // unavailable in several environments and unreadable on a phone.
      if (next.length === 0) {
        setRolesError('A user must have at least one role.');
        return;
      }

      setRolesError(null);
      setMutating(true);
      try {
        await updateUserRoles(rolesTarget.id, next);
      } catch (err) {
        setRolesError(
          err instanceof Error ? err.message : 'Failed to update user roles',
        );
      } finally {
        setMutating(false);
      }
    },
    [rolesTarget, updateUserRoles],
  );

  // --- Row actions -----------------------------------------------------------
  //
  // Built from the caller's permissions, so an action they may not perform is
  // absent from the grid menu AND the card menu. `Activate` and `Deactivate`
  // are two declarations rather than one dynamic label because a row action's
  // label is static by contract (docs/specs/datatable.md §5.5); each is
  // disabled on the rows it cannot apply to.
  const rowActions = useMemo<DataTableRowAction<UserListItem>[]>(() => {
    const actions: DataTableRowAction<UserListItem>[] = [];

    if (canWriteUsers) {
      actions.push({
        id: 'activate',
        label: 'Activate',
        icon: <ActivateIcon fontSize="small" color="success" />,
        disabled: (user) => mutating || user.isActive,
        onClick: (user) => void handleSetActive(user, true),
      });
      actions.push({
        id: 'deactivate',
        label: 'Deactivate',
        icon: <DeactivateIcon fontSize="small" />,
        destructive: true,
        disabled: (user) => mutating || !user.isActive,
        confirm: {
          title: 'Deactivate user?',
          // Names the target: a card's overflow menu is one tap from here.
          description: (user) =>
            `${user.email} will immediately lose access to MemoriaHub. You can reactivate them later.`,
          confirmLabel: 'Deactivate',
        },
        onClick: (user) => void handleSetActive(user, false),
      });
    }

    if (canManageRoles) {
      actions.push({
        id: 'roles',
        label: 'Change roles',
        icon: <RolesIcon fontSize="small" />,
        disabled: () => mutating,
        onClick: (user) => {
          setRolesError(null);
          setRolesTargetId(user.id);
        },
      });
    }

    return actions;
  }, [canWriteUsers, canManageRoles, mutating, handleSetActive]);

  const emptyState = (
    <Typography variant="body2" color="text.secondary">
      {search ? 'No users found matching your search' : 'No users found'}
    </Typography>
  );

  return (
    <Paper sx={{ width: '100%', p: 2 }}>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {/*
        Rendered unconditionally — `loading` is a prop, not a branch. Swapping
        the table for a spinner (as the pre-#260 component did) unmounts the
        renderer on every refetch and takes card/row expansion state and the
        page's scroll offset with it (docs/specs/datatable.md §18.4).
      */}
      <DataTable<UserListItem>
        columns={columns}
        rows={users}
        rowId={(user) => user.id}
        tableId={USERS_TABLE_ID}
        ariaLabel="Users"
        loading={isLoading}
        error={error}
        emptyState={emptyState}
        pagination={{
          page,
          pageSize,
          total,
          onPaginationChange: ({ page: nextPage, pageSize: nextPageSize }) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          },
          pageSizeOptions: [5, 10, 25, 50],
        }}
        quickSearch={{
          value: search,
          onChange: (next) => {
            setSearch(next);
            setPage(0); // a new search invalidates the current offset
          },
          ariaLabel: 'Search by email or name',
          placeholder: 'Search by email or name',
        }}
        filters={filterModel}
        onFiltersChange={(next) => {
          setFilterModel(normalizeUserFilters(next));
          setPage(0);
        }}
        rowActions={rowActions}
        csvExport={{ filename: 'users' }}
      />

      {/* --- Change roles ------------------------------------------------------
          A dialog rather than the old nested `Menu`: a sub-menu anchored to a
          row's overflow button is unreachable on a phone, and a checkbox list
          inside a `Menu` is a scrolling popover with no focus trap. */}
      <Dialog
        open={Boolean(rolesTarget)}
        onClose={() => setRolesTargetId(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Change roles</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {rolesTarget?.email}
          </Typography>
          {rolesError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {rolesError}
            </Alert>
          )}
          <Stack>
            {AVAILABLE_ROLES.map((availableRole) => (
              <FormControlLabel
                key={availableRole}
                sx={{ minHeight: 44 }}
                control={
                  <Checkbox
                    checked={rolesTarget?.roles.includes(availableRole) ?? false}
                    disabled={mutating}
                    onChange={() => void handleRoleToggle(availableRole)}
                  />
                }
                label={availableRole}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRolesTargetId(null)}>Done</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(successMessage)}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage ?? undefined}
      />
    </Paper>
  );
}
