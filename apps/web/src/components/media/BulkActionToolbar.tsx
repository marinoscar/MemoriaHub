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
  CircularProgress,
  Button,
  IconButton,
  Tooltip,
  ListItemIcon,
  ListItemText,
  Divider,
} from '@mui/material';
import {
  LocationOn as LocationOnIcon,
  Label as LabelIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
  RemoveCircleOutlined as RemoveCircleOutlineIcon,
  SelectAll as SelectAllIcon,
  Add as AddIcon,
  FavoriteBorder as FavoriteBorderIcon,
  MoreVert as MoreVertIcon,
  StarBorder as StarBorderIcon,
} from '@mui/icons-material';
import type { CircleRole } from '../../types/circles';
import { bulkUpdateMedia, bulkDelete } from '../../services/media';

interface BulkActionToolbarProps {
  selected: Set<string>;
  circleId: string;
  activeCircleRole: CircleRole | null;
  onClear: () => void;
  onSelectAll: () => void;
  onOpenLocation: () => void;
  onOpenTags: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  onOpenAlbum?: () => void;
  albumMode?: boolean;
  onRemoveFromAlbum?: () => void;
}

export function BulkActionToolbar({
  selected,
  circleId,
  activeCircleRole,
  onClear,
  onSelectAll,
  onOpenLocation,
  onOpenTags,
  onSuccess,
  onError,
  onOpenAlbum,
  albumMode,
  onRemoveFromAlbum,
}: BulkActionToolbarProps) {
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const isViewer = activeCircleRole === 'viewer';
  const ids = Array.from(selected);
  const count = ids.length;

  if (count === 0) return null;

  const handleFavorite = async (favorite: boolean) => {
    setLoading(true);
    try {
      const result = await bulkUpdateMedia({ circleId, ids, set: { favorite } });
      onSuccess(`Updated ${result.updated} item${result.updated !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update favorites');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setDeleteConfirmOpen(false);
    setLoading(true);
    try {
      const result = await bulkDelete({ circleId, ids });
      onSuccess(`Deleted ${result.deleted} item${result.deleted !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete items');
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
          mx: { xs: 0, md: 0 },
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
        {/* Left cluster */}
        <Tooltip title="Cancel selection">
          <IconButton aria-label="Cancel selection" onClick={onClear}>
            <CloseIcon />
          </IconButton>
        </Tooltip>

        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'primary.main' }}>
          {count} selected
        </Typography>

        {/* Spacer */}
        <Box sx={{ flexGrow: 1 }} />

        {/* Right cluster */}
        <Tooltip title="Select all">
          <IconButton aria-label="Select all" onClick={onSelectAll}>
            <SelectAllIcon />
          </IconButton>
        </Tooltip>

        {!isViewer && (
          <>
            {onOpenAlbum && (
              <Tooltip title="Add to album">
                <IconButton aria-label="Add to album" onClick={onOpenAlbum} disabled={loading}>
                  <AddIcon />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title="Add to favorites">
              <IconButton
                aria-label="Add to favorites"
                onClick={() => void handleFavorite(true)}
                disabled={loading}
              >
                {loading ? <CircularProgress size={20} /> : <FavoriteBorderIcon />}
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
        <MenuItem onClick={() => { setMoreAnchor(null); onOpenLocation(); }}>
          <ListItemIcon><LocationOnIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Set location</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setMoreAnchor(null); onOpenTags(); }}>
          <ListItemIcon><LabelIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Edit tags</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => { setMoreAnchor(null); void handleFavorite(false); }}>
          <ListItemIcon><StarBorderIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Remove from favorites</ListItemText>
        </MenuItem>
        {albumMode && onRemoveFromAlbum && (
          <MenuItem onClick={() => { setMoreAnchor(null); onRemoveFromAlbum(); }}>
            <ListItemIcon><RemoveCircleOutlineIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Remove from album</ListItemText>
          </MenuItem>
        )}
        <Divider />
        <MenuItem onClick={() => { setMoreAnchor(null); setDeleteConfirmOpen(true); }} sx={{ color: 'error.main' }}>
          <ListItemIcon><DeleteIcon fontSize="small" sx={{ color: 'error.main' }} /></ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>

      {/* Delete confirm */}
      <Dialog open={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete {count} item{count !== 1 ? 's' : ''}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This will permanently delete {count} selected item{count !== 1 ? 's' : ''}. This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
          <Button onClick={() => void handleDelete()} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
