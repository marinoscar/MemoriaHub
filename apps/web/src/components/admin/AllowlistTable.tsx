/**
 * User Management → Allowlist tab.
 *
 * Migrated onto the shared DataTable in issue #260 (epic #238). What that
 * deleted: a hand-rolled 6-column `<Table>`, its `TablePagination` footer, a
 * bespoke search `TextField`, and a `window.confirm("Are you sure…?")` — a
 * browser modal that names nothing, cannot be styled, and is suppressed
 * outright by some mobile browsers.
 *
 * Three things this migration is specifically responsible for (issue #260):
 *
 * 1. **Removing an entry confirms, and the confirmation names the email.**
 *    "Remove pending@example.com from the allowlist?" — not "Are you sure?".
 * 2. **A claimed entry still cannot be removed.** The rule that stops an
 *    operator revoking a live user's access by accident is now the row action's
 *    `disabled` predicate, which both renderers honour: the grid disables the
 *    icon button, the card disables the menu item. It is not a grid-only
 *    affordance that a card silently drops.
 * 3. **Removal is gated on `allowlist:write` in BOTH renderers.** The action
 *    list is built from the caller's permissions, so an operator who may only
 *    READ the allowlist has no remove control anywhere in the DOM — not merely
 *    off-screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Paper, Snackbar, Typography } from '@mui/material';
import { Delete as DeleteIcon, Add as AddIcon } from '@mui/icons-material';
import { useAllowlist } from '../../hooks/useAllowlist';
import { usePermissions } from '../../hooks/usePermissions';
import { AddEmailDialog } from './AddEmailDialog';
import { DataTable, type DataTableFilterModel, type DataTableRowAction } from '../datatable';
import {
  ALLOWLIST_TABLE_ID,
  buildAllowlistColumns,
  isClaimed,
  normalizeAllowlistFilters,
  toAllowlistQuery,
} from './allowlistColumns';
import type { AllowedEmailEntry } from '../../types';

const DEFAULT_PAGE_SIZE = 10;

export function AllowlistTable() {
  const { entries, total, isLoading, error, fetchAllowlist, addEmail, removeEmail } =
    useAllowlist();
  const { hasPermission } = usePermissions();

  const canWriteAllowlist = hasPermission('allowlist:write');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [filterModel, setFilterModel] = useState<DataTableFilterModel>([]);
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { status } = useMemo(() => toAllowlistQuery(filterModel), [filterModel]);

  useEffect(() => {
    fetchAllowlist({
      page: page + 1, // the API is 1-based, the table 0-based
      pageSize,
      search: search || undefined,
      status,
    });
  }, [page, pageSize, search, status, fetchAllowlist]);

  const columns = useMemo(() => buildAllowlistColumns(), []);

  const handleRemove = useCallback(
    async (entry: AllowedEmailEntry) => {
      setMutating(true);
      setActionError(null);
      try {
        await removeEmail(entry.id);
        setSuccessMessage(`${entry.email} removed from the allowlist`);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to remove email');
      } finally {
        setMutating(false);
      }
    },
    [removeEmail],
  );

  const handleAddEmail = async (email: string, notes?: string) => {
    await addEmail(email, notes);
  };

  // Gated on the caller's permission, so a read-only operator gets no remove
  // control in the grid OR the card.
  const rowActions = useMemo<DataTableRowAction<AllowedEmailEntry>[]>(() => {
    if (!canWriteAllowlist) return [];
    return [
      {
        id: 'remove',
        label: 'Remove from allowlist',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // The claimed-entry rule, in the one place both renderers read.
        disabled: (entry) => mutating || isClaimed(entry),
        confirm: {
          title: 'Remove from allowlist?',
          description: (entry) =>
            `${entry.email} will no longer be able to sign in. You can add the address again later.`,
          confirmLabel: 'Remove',
        },
        onClick: (entry) => void handleRemove(entry),
      },
    ];
  }, [canWriteAllowlist, mutating, handleRemove]);

  const emptyState = (
    <Typography variant="body2" color="text.secondary">
      {search ? 'No emails found matching your search' : 'No emails in allowlist'}
    </Typography>
  );

  return (
    <Paper sx={{ width: '100%', p: 2 }}>
      {canWriteAllowlist && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setDialogOpen(true)}
          >
            Add Email
          </Button>
        </Box>
      )}

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {/* Rendered unconditionally; `loading` is a prop, never a branch (§18.4). */}
      <DataTable<AllowedEmailEntry>
        columns={columns}
        rows={entries}
        rowId={(entry) => entry.id}
        tableId={ALLOWLIST_TABLE_ID}
        ariaLabel="Email allowlist"
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
            setPage(0);
          },
          ariaLabel: 'Search by email',
          placeholder: 'Search by email',
        }}
        filters={filterModel}
        onFiltersChange={(next) => {
          setFilterModel(normalizeAllowlistFilters(next));
          setPage(0);
        }}
        rowActions={rowActions}
        csvExport={{ filename: 'allowlist' }}
      />

      <AddEmailDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdd={handleAddEmail}
      />

      <Snackbar
        open={Boolean(successMessage)}
        autoHideDuration={3000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage ?? undefined}
      />
    </Paper>
  );
}
