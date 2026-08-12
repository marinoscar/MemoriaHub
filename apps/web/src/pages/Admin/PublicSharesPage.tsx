/**
 * Admin → Public Sharing (`/admin/settings/sharing`).
 *
 * Migrated onto the shared DataTable in issue #259 (epic #238). This was the
 * worst-affected surface after the Job Queue: on a phone the checkbox column and
 * Preview were visible, Type and Items partially, and the Public URL plus the
 * ENTIRE per-row action column — revoke, set expiration, delete — were off
 * screen. The one thing you open this page on a phone to do was the one thing
 * you could not reach.
 *
 * What the migration deleted: a hand-rolled 9-column `<Table>`, a bespoke
 * selection model (`toggleSelect` / `toggleSelectAll` / `allSelected`), a
 * hand-built bulk-action `Paper`, a `TablePagination` footer, and two of the
 * three confirm dialogs.
 *
 * ## The tabs are the filter model, not a second filter surface
 *
 * The All / Active / Expired / Revoked strip stays (issue #259's decision), but
 * it now writes into the table's own normalized filter model and reads the
 * active tab back out of it (`./sharesTable.tsx`). The `status` column declares
 * no `filterable`, so the generic "Add filter" picker never offers a second
 * control for the same param.
 *
 * ## Permissions
 *
 * Unchanged: the page is Admin-gated (`shares:manage_any` is what the API
 * enforces for `scope=all` and for the bulk endpoint).
 */

import { useState, useCallback, useMemo } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  IconButton,
  Tooltip,
  Button,
  Stack,
  CircularProgress,
  Alert,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Tabs,
  Tab,
  Link,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import RevokeIcon from '@mui/icons-material/Block';
import DeleteIcon from '@mui/icons-material/Delete';
import PublicIcon from '@mui/icons-material/Public';
import RefreshIcon from '@mui/icons-material/Refresh';
import { usePermissions } from '../../hooks/usePermissions';
import { useMediaShares } from '../../hooks/useMediaShares';
import type { MediaShare } from '../../types/sharing';
import {
  DataTable,
  type DataTableBulkAction,
  type DataTableFilterModel,
  type DataTableRowAction,
} from '../../components/datatable';
import {
  SHARES_EMPTY_STATE,
  SHARES_TABLE_ID,
  buildShareColumns,
  normalizeShareFilters,
  statusFromFilters,
  toShareQuery,
  withStatusFilter,
  type ShareStatusFilter,
} from './sharesTable';

const DEFAULT_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Edit expiration dialog
// ---------------------------------------------------------------------------

interface EditExpirationDialogProps {
  share: MediaShare | null;
  onClose: () => void;
  onSave: (id: string, expiresAt: string | null) => Promise<void>;
}

function EditExpirationDialog({ share, onClose, onSave }: EditExpirationDialogProps) {
  const [mode, setMode] = useState<'never' | 'custom'>(() => {
    return share?.expiresAt ? 'custom' : 'never';
  });
  const [dateValue, setDateValue] = useState<string>(() => {
    if (share?.expiresAt) {
      // Convert ISO to datetime-local format (YYYY-MM-DDTHH:mm)
      return share.expiresAt.slice(0, 16);
    }
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 16);
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!share) return;
    setSaving(true);
    try {
      const expiresAt = mode === 'never' ? null : new Date(dateValue).toISOString();
      await onSave(share.id, expiresAt);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!share} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Edit Expiration</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Tabs
            value={mode}
            onChange={(_, v) => setMode(v as 'never' | 'custom')}
            variant="fullWidth"
          >
            <Tab label="Never expires" value="never" />
            <Tab label="Custom date" value="custom" />
          </Tabs>
          {mode === 'custom' && (
            <TextField
              label="Expires at"
              type="datetime-local"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? <CircularProgress size={18} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Confirm revoke dialog (bulk only — the per-row revoke uses the DataTable's
// own single confirm dialog, so there is exactly one implementation per gesture)
// ---------------------------------------------------------------------------

interface ConfirmRevokeDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  count?: number;
}

function ConfirmRevokeDialog({ open, onClose, onConfirm, count = 1 }: ConfirmRevokeDialogProps) {
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Revoke {count > 1 ? `${count} shares` : 'share'}?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {count > 1
            ? `This will revoke ${count} share links immediately. Anyone with these links will no longer be able to access the shared media.`
            : 'This will revoke the share link immediately. Anyone with this link will no longer be able to access the shared media.'}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>Cancel</Button>
        <Button onClick={handleConfirm} color="error" variant="contained" disabled={loading}>
          {loading ? <CircularProgress size={18} /> : 'Revoke'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk expiration dialog
// ---------------------------------------------------------------------------

interface BulkExpirationDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (expiresAt: string | null) => Promise<void>;
  count: number;
}

function BulkExpirationDialog({ open, onClose, onSave, count }: BulkExpirationDialogProps) {
  const [mode, setMode] = useState<'never' | 'custom'>('never');
  const [dateValue, setDateValue] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 16);
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const expiresAt = mode === 'never' ? null : new Date(dateValue).toISOString();
      await onSave(expiresAt);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Set Expiration for {count} shares</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Tabs
            value={mode}
            onChange={(_, v) => setMode(v as 'never' | 'custom')}
            variant="fullWidth"
          >
            <Tab label="Never expires" value="never" />
            <Tab label="Custom date" value="custom" />
          </Tabs>
          {mode === 'custom' && (
            <TextField
              label="Expires at"
              type="datetime-local"
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? <CircularProgress size={18} /> : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page content
// ---------------------------------------------------------------------------

function PublicSharesPageContent() {
  // --- Controlled table state (all of it lives HERE, above the table) --------

  const [filterModel, setFilterModel] = useState<DataTableFilterModel>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Dialogs
  const [editShare, setEditShare] = useState<MediaShare | null>(null);
  const [showBulkRevokeConfirm, setShowBulkRevokeConfirm] = useState(false);
  const [showBulkExpiration, setShowBulkExpiration] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  // Snackbar
  const [snack, setSnack] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  const query = useMemo(() => toShareQuery(filterModel), [filterModel]);
  const statusFilter: ShareStatusFilter = statusFromFilters(filterModel);

  const hookParams = useMemo(
    () => ({
      scope: 'all' as const,
      status: query.status,
      targetType: query.targetType,
      page: page + 1, // the API is 1-based, the table 0-based
      pageSize,
    }),
    [query.status, query.targetType, page, pageSize],
  );

  const {
    shares,
    meta,
    isLoading,
    error,
    refetch,
    updateShare,
    revokeShare: revokeShareFn,
    bulkAction,
  } = useMediaShares(hookParams);

  // --- Filter model ----------------------------------------------------------

  const applyFilters = useCallback((next: DataTableFilterModel) => {
    setFilterModel(normalizeShareFilters(next));
    // A new filter invalidates the current offset, and any selection made
    // against rows that are about to be replaced.
    setPage(0);
    setSelectedIds(new Set());
  }, []);

  /** The tab strip writes straight into the table's own filter model. */
  const handleStatusChange = useCallback(
    (_: React.SyntheticEvent, value: ShareStatusFilter) => {
      setFilterModel((current) => withStatusFilter(current, value));
      setPage(0);
      setSelectedIds(new Set());
    },
    [],
  );

  const handlePaginationChange = useCallback(
    ({ page: nextPage, pageSize: nextPageSize }: { page: number; pageSize: number }) => {
      setPage(nextPage);
      setPageSize(nextPageSize);
    },
    [],
  );

  // --- Mutations -------------------------------------------------------------

  const handleCopy = useCallback(async (share: MediaShare) => {
    try {
      await navigator.clipboard.writeText(share.publicUrl);
      setSnack({ message: 'Link copied to clipboard', severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to copy link', severity: 'error' });
    }
  }, []);

  const handleUpdateExpiration = useCallback(async (id: string, expiresAt: string | null) => {
    try {
      await updateShare(id, { expiresAt });
      setSnack({ message: 'Expiration updated', severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to update expiration', severity: 'error' });
      throw new Error('Failed');
    }
  }, [updateShare]);

  const handleRevokeSingle = useCallback(async (share: MediaShare) => {
    try {
      await revokeShareFn(share.id);
      setSnack({ message: 'Share revoked', severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to revoke share', severity: 'error' });
    }
  }, [revokeShareFn]);

  const handleBulkRevoke = useCallback(async () => {
    try {
      const result = await bulkAction({ ids: Array.from(selectedIds), action: 'revoke' });
      setSelectedIds(new Set());
      setSnack({ message: `${result.affected} shares revoked`, severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to revoke shares', severity: 'error' });
      throw new Error('Failed');
    }
  }, [bulkAction, selectedIds]);

  const handleBulkSetExpiration = useCallback(async (expiresAt: string | null) => {
    try {
      const result = await bulkAction({ ids: Array.from(selectedIds), action: 'set_expiration', expiresAt });
      setSelectedIds(new Set());
      setSnack({ message: `${result.affected} shares updated`, severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to update shares', severity: 'error' });
      throw new Error('Failed');
    }
  }, [bulkAction, selectedIds]);

  const handleBulkDelete = useCallback(async () => {
    try {
      const result = await bulkAction({ ids: Array.from(selectedIds), action: 'delete' });
      setSelectedIds(new Set());
      setSnack({ message: `${result.affected} shares deleted`, severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to delete shares', severity: 'error' });
      throw new Error('Failed');
    }
  }, [bulkAction, selectedIds]);

  // --- Columns / actions -----------------------------------------------------

  const columns = useMemo(
    () => buildShareColumns({ onCopy: (share) => void handleCopy(share) }),
    [handleCopy],
  );

  const rowActions = useMemo<DataTableRowAction<MediaShare>[]>(
    () => [
      {
        id: 'edit-expiration',
        label: 'Edit expiration',
        icon: <EditIcon fontSize="small" />,
        disabled: (share) => share.status === 'revoked',
        onClick: (share) => setEditShare(share),
      },
      {
        id: 'revoke',
        label: 'Revoke',
        icon: <RevokeIcon fontSize="small" />,
        destructive: true,
        disabled: (share) => share.status === 'revoked',
        confirm: {
          title: 'Revoke share?',
          description:
            'This will revoke the share link immediately. Anyone with this link will no longer be able to access the shared media.',
          confirmLabel: 'Revoke',
        },
        onClick: (share) => void handleRevokeSingle(share),
      },
    ],
    [handleRevokeSingle],
  );

  const bulkActions = useMemo<DataTableBulkAction[]>(
    () => [
      {
        id: 'revoke',
        label: 'Revoke',
        icon: <RevokeIcon fontSize="small" />,
        destructive: true,
        onClick: () => setShowBulkRevokeConfirm(true),
      },
      {
        id: 'set-expiration',
        label: 'Set expiration',
        icon: <EditIcon fontSize="small" />,
        onClick: () => setShowBulkExpiration(true),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        onClick: () => setShowBulkDeleteConfirm(true),
      },
    ],
    [],
  );

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Link
        component={RouterLink}
        to="/admin/settings"
        underline="hover"
        variant="body2"
        sx={{ display: 'inline-block', mb: 2 }}
      >
        &larr; Back to Settings
      </Link>

      {/* Header */}
      <Stack direction="row" spacing={2} sx={{ mb: 3, alignItems: 'center' }}>
        <PublicIcon color="primary" sx={{ fontSize: 32 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
            Public Sharing
          </Typography>
          <Typography variant="body2" color="text.secondary">
            View and manage all public share links across the application.
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={() => refetch()} disabled={isLoading}>
            {isLoading ? <CircularProgress size={20} /> : <RefreshIcon />}
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Status filter tabs — a quick-filter preset over the table's own filter
          model (see ./sharesTable.tsx). `variant="scrollable"` keeps four tabs
          inside 360px instead of pushing the document sideways. */}
      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Tabs
          value={statusFilter}
          onChange={handleStatusChange}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
        >
          <Tab label="All" value="all" />
          <Tab label="Active" value="active" />
          <Tab label="Expired" value="expired" />
          <Tab label="Revoked" value="revoked" />
        </Tabs>
      </Paper>

      {/*
        Rendered unconditionally: `loading` is a prop so a refetch draws an
        overlay over rows that stay mounted, rather than unmounting the
        renderer and losing its expansion state (docs/specs/datatable.md §18.4).
      */}
      <DataTable<MediaShare>
        columns={columns}
        rows={shares}
        rowId={(share) => share.id}
        tableId={SHARES_TABLE_ID}
        ariaLabel="Public shares"
        density="compact"
        loading={isLoading}
        error={error}
        emptyState={SHARES_EMPTY_STATE}
        pagination={{
          page,
          pageSize,
          total: meta?.totalItems ?? shares.length,
          onPaginationChange: handlePaginationChange,
          pageSizeOptions: [10, 20, 50, 100],
        }}
        filters={filterModel}
        onFiltersChange={applyFilters}
        selection={{ selectedIds, onSelectionChange: setSelectedIds }}
        rowActions={rowActions}
        bulkActions={bulkActions}
        csvExport={{ filename: 'public-shares' }}
      />

      {/* Dialogs */}
      <EditExpirationDialog
        share={editShare}
        onClose={() => setEditShare(null)}
        onSave={handleUpdateExpiration}
      />

      <ConfirmRevokeDialog
        open={showBulkRevokeConfirm}
        onClose={() => setShowBulkRevokeConfirm(false)}
        onConfirm={handleBulkRevoke}
        count={selectedIds.size}
      />

      {/* Bulk delete confirm */}
      <Dialog
        open={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete {selectedIds.size} shares?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently delete {selectedIds.size} share records. This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={async () => {
              await handleBulkDelete();
              setShowBulkDeleteConfirm(false);
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <BulkExpirationDialog
        open={showBulkExpiration}
        onClose={() => setShowBulkExpiration(false)}
        onSave={handleBulkSetExpiration}
        count={selectedIds.size}
      />

      {/* Snackbar */}
      <Snackbar
        open={!!snack}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack ? (
          <Alert severity={snack.severity} onClose={() => setSnack(null)} variant="filled">
            {snack.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Default export — admin-gated
// ---------------------------------------------------------------------------

export default function PublicSharesPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <PublicSharesPageContent />;
}
