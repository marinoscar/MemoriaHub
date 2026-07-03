import { useState, useCallback, useMemo } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Chip,
  IconButton,
  Tooltip,
  Button,
  Stack,
  Checkbox,
  CircularProgress,
  Alert,
  Snackbar,
  Avatar,
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
import {
  ContentCopy as CopyIcon,
  Edit as EditIcon,
  Block as RevokeIcon,
  Delete as DeleteIcon,
  Public as PublicIcon,
  Image as ImageIcon,
  PhotoLibrary as AlbumIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useMediaShares } from '../../hooks/useMediaShares';
import type { MediaShare, ShareStatus } from '../../types/sharing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function truncateUrl(url: string, maxLen = 48): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen) + '…';
}

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
// Confirm revoke dialog
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
// Status tab type
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | ShareStatus;

// ---------------------------------------------------------------------------
// Main page content
// ---------------------------------------------------------------------------

function PublicSharesPageContent() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);
  const [pageSize] = useState(20);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Dialogs
  const [editShare, setEditShare] = useState<MediaShare | null>(null);
  const [revokeShare, setRevokeShare] = useState<MediaShare | null>(null);
  const [showBulkRevokeConfirm, setShowBulkRevokeConfirm] = useState(false);
  const [showBulkExpiration, setShowBulkExpiration] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  // Snackbar
  const [snack, setSnack] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  const hookParams = useMemo(() => ({
    scope: 'all' as const,
    status: statusFilter === 'all' ? undefined : statusFilter,
    page: page + 1,
    pageSize,
  }), [statusFilter, page, pageSize]);

  const { shares, meta, isLoading, error, refetch, updateShare, revokeShare: revokeShareFn, bulkAction } = useMediaShares(hookParams);

  // Reset page when filter changes
  const handleStatusChange = useCallback((_: React.SyntheticEvent, val: StatusFilter) => {
    setStatusFilter(val);
    setPage(0);
    setSelectedIds(new Set());
  }, []);

  // Selection
  const allIds = useMemo(() => shares.map((s) => s.id), [shares]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  }, [allSelected, allIds]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Copy URL
  const handleCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setSnack({ message: 'Link copied to clipboard', severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to copy link', severity: 'error' });
    }
  }, []);

  // Edit expiration
  const handleUpdateExpiration = useCallback(async (id: string, expiresAt: string | null) => {
    try {
      await updateShare(id, { expiresAt });
      setSnack({ message: 'Expiration updated', severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to update expiration', severity: 'error' });
      throw new Error('Failed');
    }
  }, [updateShare]);

  // Revoke single
  const handleRevokeSingle = useCallback(async () => {
    if (!revokeShare) return;
    try {
      await revokeShareFn(revokeShare.id);
      setSnack({ message: 'Share revoked', severity: 'success' });
    } catch {
      setSnack({ message: 'Failed to revoke share', severity: 'error' });
      throw new Error('Failed');
    }
  }, [revokeShare, revokeShareFn]);

  // Bulk revoke
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

  // Bulk set expiration
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

  // Bulk delete
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
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
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

      {/* Status filter tabs */}
      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Tabs value={statusFilter} onChange={handleStatusChange}>
          <Tab label="All" value="all" />
          <Tab label="Active" value="active" />
          <Tab label="Expired" value="expired" />
          <Tab label="Revoked" value="revoked" />
        </Tabs>
      </Paper>

      {/* Bulk action bar */}
      {someSelected && (
        <Paper
          variant="outlined"
          sx={{
            mb: 2,
            p: 1.5,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            backgroundColor: 'action.selected',
          }}
        >
          <Typography variant="body2" sx={{ mr: 1, fontWeight: 500 }}>
            {selectedIds.size} selected
          </Typography>
          <Button
            size="small"
            color="error"
            startIcon={<RevokeIcon />}
            onClick={() => setShowBulkRevokeConfirm(true)}
          >
            Revoke
          </Button>
          <Button
            size="small"
            startIcon={<EditIcon />}
            onClick={() => setShowBulkExpiration(true)}
          >
            Set expiration
          </Button>
          <Button
            size="small"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={() => setShowBulkDeleteConfirm(true)}
          >
            Delete
          </Button>
          <Button size="small" sx={{ ml: 'auto' }} onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </Button>
        </Paper>
      )}

      {/* Error */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Table */}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={toggleSelectAll}
                  disabled={shares.length === 0}
                />
              </TableCell>
              <TableCell>Preview</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Items</TableCell>
              <TableCell>Public URL</TableCell>
              <TableCell>Expires</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading && shares.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={24} />
                </TableCell>
              </TableRow>
            ) : shares.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                  <Typography variant="body2" color="text.secondary">
                    No shares found.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              shares.map((share) => (
                <TableRow
                  key={share.id}
                  hover
                  selected={selectedIds.has(share.id)}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={selectedIds.has(share.id)}
                      onChange={() => toggleSelect(share.id)}
                    />
                  </TableCell>
                  <TableCell>
                    {share.preview?.thumbnailUrl ? (
                      <Avatar
                        src={share.preview.thumbnailUrl}
                        variant="rounded"
                        sx={{ width: 40, height: 40 }}
                      />
                    ) : (
                      <Avatar variant="rounded" sx={{ width: 40, height: 40, bgcolor: 'action.disabledBackground' }}>
                        {share.targetType === 'album' ? (
                          <AlbumIcon sx={{ fontSize: 20, color: 'text.disabled' }} />
                        ) : (
                          <ImageIcon sx={{ fontSize: 20, color: 'text.disabled' }} />
                        )}
                      </Avatar>
                    )}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      {share.targetType === 'album' ? (
                        <AlbumIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                      ) : (
                        <ImageIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                      )}
                      <Typography variant="body2">
                        {share.targetType === 'album' ? 'Album' : 'Photo'}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {share.targetType === 'album' && share.itemCount != null
                        ? share.itemCount
                        : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Tooltip title={share.publicUrl} arrow>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        {truncateUrl(share.publicUrl)}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {formatDate(share.expiresAt)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <ShareStatusChip status={share.status} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {formatDateShort(share.createdAt)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                      <Tooltip title="Copy link">
                        <IconButton size="small" onClick={() => handleCopy(share.publicUrl)}>
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit expiration">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => setEditShare(share)}
                            disabled={share.status === 'revoked'}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Revoke">
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => setRevokeShare(share)}
                            disabled={share.status === 'revoked'}
                          >
                            <RevokeIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Pagination */}
      {meta && (
        <TablePagination
          component="div"
          count={meta.totalItems}
          page={page}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[pageSize]}
          onPageChange={(_, p) => setPage(p)}
        />
      )}

      {/* Dialogs */}
      <EditExpirationDialog
        share={editShare}
        onClose={() => setEditShare(null)}
        onSave={handleUpdateExpiration}
      />

      <ConfirmRevokeDialog
        open={!!revokeShare}
        onClose={() => setRevokeShare(null)}
        onConfirm={handleRevokeSingle}
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
