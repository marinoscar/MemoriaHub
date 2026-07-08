import { useState } from 'react';
import {
  Box,
  Typography,
  Alert,
  Snackbar,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
} from '@mui/material';
import { DeleteOutlined as TrashIcon } from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { MediaGallery } from '../../components/media/MediaGallery';
import { listTrash, emptyTrash } from '../../services/media';

const RETENTION_DAYS = 30;

export default function TrashPage() {
  const { activeCircleId, activeCircleRole } = useCircle();

  const [refreshToken, setRefreshToken] = useState(0);

  // Empty Trash dialog + snackbar
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [emptyLoading, setEmptyLoading] = useState(false);
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(
    null,
  );

  if (!activeCircleId) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">Select a circle to view the trash.</Typography>
      </Box>
    );
  }

  const circleId = activeCircleId;
  const isCircleAdmin = activeCircleRole === 'circle_admin';

  const handleEmptyTrash = async () => {
    setEmptyLoading(true);
    try {
      const result = await emptyTrash({ circleId });
      setEmptyConfirmOpen(false);
      setSnackbar({
        message: `Permanently deleted ${result.deleted} item${result.deleted !== 1 ? 's' : ''}`,
        severity: 'success',
      });
      setRefreshToken((t) => t + 1);
    } catch (err) {
      setEmptyConfirmOpen(false);
      setSnackbar({
        message: err instanceof Error ? err.message : 'Failed to empty trash',
        severity: 'error',
      });
    } finally {
      setEmptyLoading(false);
    }
  };

  const emptyState = (
    <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
      <TrashIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6" color="text.secondary">
        Trash is empty
      </Typography>
      <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
        Deleted items will appear here for {RETENTION_DAYS} days before being removed permanently
      </Typography>
    </Box>
  );

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
            <TrashIcon sx={{ color: 'text.secondary' }} />
            <Typography variant="h5" component="h1">
              Trash
            </Typography>
          </Box>

          {/* Empty trash button — only circle admins */}
          {isCircleAdmin && (
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={() => setEmptyConfirmOpen(true)}
              disabled={emptyLoading}
              startIcon={<TrashIcon />}
            >
              Empty Trash
            </Button>
          )}
        </Box>
        <Typography variant="body2" color="text.secondary">
          Items in Trash are permanently deleted after {RETENTION_DAYS} days.
        </Typography>
      </Box>

      {/* Gallery (feed mode) */}
      <MediaGallery
        mode="trash"
        circleId={circleId}
        activeCircleRole={activeCircleRole}
        fetcher={(page, pageSize) =>
          listTrash({ circleId, page, pageSize }).then((r) => ({
            items: r.items,
            totalPages: r.meta.totalPages,
          }))
        }
        queryKey={`trash:${circleId}:${refreshToken}`}
        emptyState={emptyState}
      />

      {/* Empty Trash confirm dialog */}
      <Dialog open={emptyConfirmOpen} onClose={() => setEmptyConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Empty Trash?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            All items in Trash will be permanently deleted. This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEmptyConfirmOpen(false)} disabled={emptyLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleEmptyTrash()}
            color="error"
            variant="contained"
            disabled={emptyLoading}
          >
            {emptyLoading ? <CircularProgress size={18} /> : 'Delete All'}
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
