import { useState } from 'react';
import {
  Box,
  Typography,
  Alert,
  Snackbar,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Paper,
  Stack,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  DeleteForever as DeleteForeverIcon,
  Restore as RestoreIcon,
  SelectAll as SelectAllIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useUnassignedFaces } from '../../hooks/useUnassignedFaces';
import { FaceThumbGrid } from '../../components/people/FaceThumbGrid';
import { PurgeFacesDialog } from '../../components/people/PurgeFacesDialog';

export default function ArchivedFacesPage() {
  const navigate = useNavigate();
  const { activeCircleId, activeCircleRole } = useCircle();

  const {
    faces,
    total,
    hasMore,
    loadMore,
    loadingMore,
    loading,
    error,
    refresh,
    unhide,
    purge,
    purgeArchived,
  } = useUnassignedFaces(activeCircleId, { archived: true });

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Dialogs
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllLoading, setDeleteAllLoading] = useState(false);

  // Snackbar
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(
    null,
  );

  if (!activeCircleId) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">Select a circle to view archived faces.</Typography>
      </Box>
    );
  }

  const canEdit = activeCircleRole !== 'viewer';

  const toggleSelect = (faceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  };

  const handleRestore = async () => {
    if (selectedIds.size === 0) return;
    setRestoring(true);
    setActionError(null);
    try {
      const ids = [...selectedIds];
      const result = await unhide(ids);
      setSelectedIds(new Set());
      await refresh();
      setSnackbar({
        message: `Restored ${result.unhidden} face${result.unhidden !== 1 ? 's' : ''}.`,
        severity: 'success',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isStale =
        msg.toLowerCase().includes('not found') ||
        (err as { status?: number }).status === 404 ||
        (err as { status?: number }).status === 400;
      if (isStale) {
        await refresh();
        setSelectedIds(new Set());
        setActionError('The face list changed. Please reselect and try again.');
      } else {
        setActionError(msg || 'Failed to restore faces');
      }
    } finally {
      setRestoring(false);
    }
  };

  // Called by PurgeFacesDialog's onConfirm — errors propagate so the dialog shows them
  const handlePurge = async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const result = await purge(ids);
    setSelectedIds(new Set());
    await refresh();
    setSnackbar({
      message: `Permanently deleted ${result.deleted} face${result.deleted !== 1 ? 's' : ''}.`,
      severity: 'success',
    });
  };

  const handleDeleteAll = async () => {
    setDeleteAllLoading(true);
    try {
      const { deleted } = await purgeArchived();
      setSelectedIds(new Set());
      await refresh();
      setDeleteAllOpen(false);
      setSnackbar({
        message: `Permanently deleted ${deleted} face${deleted !== 1 ? 's' : ''}.`,
        severity: 'success',
      });
    } catch (err) {
      setDeleteAllOpen(false);
      setSnackbar({
        message: err instanceof Error ? err.message : 'Failed to delete archived faces',
        severity: 'error',
      });
    } finally {
      setDeleteAllLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: 0 }}>
      {/* Page header */}
      <Box sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 3 }, pb: 1 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            mb: 0.5,
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <IconButton onClick={() => navigate('/people')} aria-label="Back to People">
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="h5" component="h1">
              Archived Faces ({total})
            </Typography>
          </Box>

          {/* Delete all — collaborators and admins only */}
          {canEdit && total > 0 && (
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => setDeleteAllOpen(true)}
              disabled={deleteAllLoading}
              startIcon={<DeleteForeverIcon />}
            >
              Delete all archived ({total})
            </Button>
          )}
        </Box>
        <Typography variant="body2" color="text.secondary">
          Archived faces are hidden from the unassigned faces list and excluded from clustering.
          Restore them, or delete them permanently (removes the face and its biometric data — your
          photos are kept).
        </Typography>
      </Box>

      <Box sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : total === 0 ? (
          <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
            <VisibilityOffIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" color="text.secondary">
              No archived faces
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mt: 1, mb: 2 }}>
              Faces you archive from the unassigned pool will appear here.
            </Typography>
            <Button variant="outlined" onClick={() => navigate('/people')}>
              Back to People
            </Button>
          </Box>
        ) : (
          <>
            {/* Action bar — visible when faces are selected */}
            {selectedIds.size > 0 && (
              <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  sx={{ alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
                >
                  <Typography variant="body2">
                    {selectedIds.size} face{selectedIds.size !== 1 ? 's' : ''} selected
                  </Typography>

                  {canEdit && (
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => void handleRestore()}
                      disabled={restoring}
                      startIcon={
                        restoring ? <CircularProgress size={14} /> : <RestoreIcon fontSize="small" />
                      }
                      sx={{ minHeight: 44 }}
                    >
                      {restoring ? 'Restoring…' : 'Restore'}
                    </Button>
                  )}

                  {canEdit && (
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      onClick={() => setPurgeDialogOpen(true)}
                      disabled={restoring}
                      startIcon={<DeleteForeverIcon fontSize="small" />}
                      sx={{ minHeight: 44 }}
                    >
                      Delete permanently
                    </Button>
                  )}

                  <Button size="small" onClick={() => setSelectedIds(new Set())} sx={{ minHeight: 44 }}>
                    Clear
                  </Button>
                </Stack>
                {actionError && (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {actionError}
                  </Alert>
                )}
              </Paper>
            )}

            {/* Select all / Deselect all (operates on loaded faces) */}
            {faces.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Button
                  size="small"
                  startIcon={<SelectAllIcon fontSize="small" />}
                  onClick={() =>
                    selectedIds.size === faces.length && faces.length > 0
                      ? setSelectedIds(new Set())
                      : setSelectedIds(new Set(faces.map((f) => f.faceId)))
                  }
                  sx={{ minHeight: 44 }}
                >
                  {selectedIds.size === faces.length && faces.length > 0
                    ? 'Deselect all'
                    : 'Select all'}
                </Button>
              </Box>
            )}

            {/* Face grid */}
            <FaceThumbGrid faces={faces} selectedIds={selectedIds} onToggle={toggleSelect} />

            {/* Load more — remaining pages of archived faces */}
            {hasMore && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  startIcon={loadingMore ? <CircularProgress size={16} /> : undefined}
                  sx={{ minHeight: 44 }}
                >
                  Load more ({total - faces.length} remaining)
                </Button>
              </Box>
            )}
          </>
        )}
      </Box>

      {/* Purge (permanent delete) confirm dialog for the current selection */}
      <PurgeFacesDialog
        open={purgeDialogOpen}
        count={selectedIds.size}
        onClose={() => setPurgeDialogOpen(false)}
        onConfirm={handlePurge}
      />

      {/* Delete-all-archived confirm dialog */}
      <Dialog open={deleteAllOpen} onClose={() => setDeleteAllOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete all archived faces?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            All {total} archived faces and their biometric data will be permanently deleted. Your
            photos are NOT deleted. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteAllOpen(false)} disabled={deleteAllLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleDeleteAll()}
            color="error"
            variant="contained"
            disabled={deleteAllLoading}
          >
            {deleteAllLoading ? <CircularProgress size={18} /> : 'Delete All'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar(null)}
          severity={snackbar?.severity ?? 'success'}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {snackbar?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
