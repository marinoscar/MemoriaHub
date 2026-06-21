/**
 * TrashBulkToolbar — slim toolbar shown when items are selected on the
 * Trash page. Provides Restore and Delete Forever bulk actions.
 */

import { useState } from 'react';
import {
  Box,
  Typography,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  Tooltip,
  ListItemIcon,
  ListItemText,
  Divider,
  CircularProgress,
} from '@mui/material';
import {
  Close as CloseIcon,
  SelectAll as SelectAllIcon,
  Delete as DeleteIcon,
  MoreVert as MoreVertIcon,
  RestoreFromTrash as RestoreIcon,
} from '@mui/icons-material';
import type { CircleRole } from '../../types/circles';
import { restoreFromTrash, deleteForever } from '../../services/media';

interface TrashBulkToolbarProps {
  selected: Set<string>;
  circleId: string;
  activeCircleRole: CircleRole | null;
  onClear: () => void;
  onSelectAll: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export function TrashBulkToolbar({
  selected,
  circleId,
  activeCircleRole,
  onClear,
  onSelectAll,
  onSuccess,
  onError,
}: TrashBulkToolbarProps) {
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);
  const [deleteForeverConfirmOpen, setDeleteForeverConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const isViewer = activeCircleRole === 'viewer';
  const ids = Array.from(selected);
  const count = ids.length;

  if (count === 0) return null;

  const handleRestore = async () => {
    setMoreAnchor(null);
    setLoading(true);
    try {
      const result = await restoreFromTrash({ circleId, ids });
      const msg = result.conflicts.length > 0
        ? `Restored ${result.restored} item${result.restored !== 1 ? 's' : ''}. ${result.conflicts.length} item${result.conflicts.length !== 1 ? 's' : ''} could not be restored (duplicate already exists).`
        : `Restored ${result.restored} item${result.restored !== 1 ? 's' : ''}`;
      onSuccess(msg);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to restore items');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteForever = async () => {
    setDeleteForeverConfirmOpen(false);
    setLoading(true);
    try {
      const result = await deleteForever({ circleId, ids });
      onSuccess(
        `Permanently deleted ${result.deleted} item${result.deleted !== 1 ? 's' : ''}`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to permanently delete items');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Box
        sx={{
          position: 'sticky',
          top: 64,
          zIndex: (theme) => theme.zIndex.appBar + 2,
          mx: 0,
          mb: 1.5,
          px: { xs: 1, sm: 2 },
          py: 1,
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderRadius: 2,
          boxShadow: 3,
        }}
      >
        <Tooltip title="Cancel selection">
          <IconButton aria-label="Cancel selection" onClick={onClear}>
            <CloseIcon />
          </IconButton>
        </Tooltip>

        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'primary.main' }}>
          {count} selected
        </Typography>

        <Box sx={{ flexGrow: 1 }} />

        <Tooltip title="Select all">
          <IconButton aria-label="Select all" onClick={onSelectAll}>
            <SelectAllIcon />
          </IconButton>
        </Tooltip>

        {!isViewer && (
          <>
            <Tooltip title="Restore">
              <IconButton
                aria-label="Restore selected"
                onClick={() => void handleRestore()}
                disabled={loading}
              >
                {loading ? <CircularProgress size={20} /> : <RestoreIcon />}
              </IconButton>
            </Tooltip>

            <Tooltip title="More actions">
              <IconButton
                aria-label="More actions"
                onClick={(e) => setMoreAnchor(e.currentTarget)}
                disabled={loading}
              >
                <MoreVertIcon />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>

      {/* Overflow menu */}
      <Menu anchorEl={moreAnchor} open={Boolean(moreAnchor)} onClose={() => setMoreAnchor(null)}>
        <MenuItem onClick={() => { setMoreAnchor(null); void handleRestore(); }}>
          <ListItemIcon><RestoreIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Restore</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => { setMoreAnchor(null); setDeleteForeverConfirmOpen(true); }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon><DeleteIcon fontSize="small" sx={{ color: 'error.main' }} /></ListItemIcon>
          <ListItemText>Delete forever</ListItemText>
        </MenuItem>
      </Menu>

      {/* Delete forever confirm dialog */}
      <Dialog
        open={deleteForeverConfirmOpen}
        onClose={() => setDeleteForeverConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete {count} item{count !== 1 ? 's' : ''} forever?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {count} selected item{count !== 1 ? 's' : ''} will be permanently deleted. This
            action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteForeverConfirmOpen(false)}>Cancel</Button>
          <Button
            onClick={() => void handleDeleteForever()}
            color="error"
            variant="contained"
          >
            Delete forever
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
