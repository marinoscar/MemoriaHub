/**
 * ArchiveBulkToolbar — slim toolbar shown when items are selected on the
 * Archive page. Provides Unarchive and Delete (→ Trash) bulk actions.
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
  Unarchive as UnarchiveIcon,
} from '@mui/icons-material';
import type { CircleRole } from '../../types/circles';
import { bulkUnarchive, bulkDelete } from '../../services/media';

interface ArchiveBulkToolbarProps {
  selected: Set<string>;
  circleId: string;
  activeCircleRole: CircleRole | null;
  onClear: () => void;
  onSelectAll: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export function ArchiveBulkToolbar({
  selected,
  circleId,
  activeCircleRole,
  onClear,
  onSelectAll,
  onSuccess,
  onError,
}: ArchiveBulkToolbarProps) {
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const isViewer = activeCircleRole === 'viewer';
  const ids = Array.from(selected);
  const count = ids.length;

  if (count === 0) return null;

  const handleUnarchive = async () => {
    setMoreAnchor(null);
    setLoading(true);
    try {
      const result = await bulkUnarchive({ circleId, ids });
      onSuccess(
        `Unarchived ${result.unarchived} item${result.unarchived !== 1 ? 's' : ''}`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to unarchive items');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setDeleteConfirmOpen(false);
    setLoading(true);
    try {
      const result = await bulkDelete({ circleId, ids });
      onSuccess(`Moved ${result.deleted} item${result.deleted !== 1 ? 's' : ''} to Trash`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to move items to Trash');
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
            <Tooltip title="Unarchive">
              <IconButton
                aria-label="Unarchive selected"
                onClick={() => void handleUnarchive()}
                disabled={loading}
              >
                {loading ? <CircularProgress size={20} /> : <UnarchiveIcon />}
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
        <MenuItem onClick={() => { setMoreAnchor(null); void handleUnarchive(); }}>
          <ListItemIcon><UnarchiveIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Unarchive</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => { setMoreAnchor(null); setDeleteConfirmOpen(true); }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon><DeleteIcon fontSize="small" sx={{ color: 'error.main' }} /></ListItemIcon>
          <ListItemText>Move to Trash</ListItemText>
        </MenuItem>
      </Menu>

      {/* Move to Trash confirm dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Move {count} item{count !== 1 ? 's' : ''} to Trash?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {count} selected item{count !== 1 ? 's' : ''} will be moved to Trash and can be
            recovered before permanent deletion.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
          <Button onClick={() => void handleDelete()} color="error" variant="contained">
            Move to Trash
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
