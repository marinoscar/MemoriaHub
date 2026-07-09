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
  MoreVert as MoreVertIcon,
  StarBorder as StarBorderIcon,
  Archive as ArchiveIcon,
  Unarchive as UnarchiveIcon,
  EditCalendar as EditCalendarIcon,
  PhotoSizeSelectActual as PhotoSizeSelectActualIcon,
  Face as FaceIcon,
  AutoAwesome as AutoAwesomeIcon,
} from '@mui/icons-material';
import type { CircleRole } from '../../types/circles';
import {
  bulkUpdateMedia,
  bulkDelete,
  bulkArchive,
  bulkUnarchive,
  bulkRerunTags,
  bulkRerunFaces,
  bulkRerunThumbnails,
} from '../../services/media';

/**
 * Mode controls which archive-related actions are shown.
 * - 'home'    (default): shows Archive, no Unarchive
 * - 'archive': shows Unarchive, no Archive
 * - 'trash':   neither (separate TrashBulkToolbar is used instead)
 */
export type BulkActionMode = 'home' | 'archive' | 'trash';

interface BulkActionToolbarProps {
  selected: Set<string>;
  circleId: string;
  activeCircleRole: CircleRole | null;
  onClear: () => void;
  onSelectAll: () => void;
  onOpenLocation: () => void;
  onOpenDate: () => void;
  onOpenTags: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  onOpenAlbum?: () => void;
  albumMode?: boolean;
  onRemoveFromAlbum?: () => void;
  /** Controls archive-related actions shown. Default: 'home'. */
  mode?: BulkActionMode;
}

export function BulkActionToolbar({
  selected,
  circleId,
  activeCircleRole,
  onClear,
  onSelectAll,
  onOpenLocation,
  onOpenDate,
  onOpenTags,
  onSuccess,
  onError,
  onOpenAlbum,
  albumMode,
  onRemoveFromAlbum,
  mode = 'home',
}: BulkActionToolbarProps) {
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<{ label: string; run: () => void } | null>(null);

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
      onSuccess(`Moved ${result.deleted} item${result.deleted !== 1 ? 's' : ''} to Trash`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to move items to Trash');
    } finally {
      setLoading(false);
    }
  };

  const handleArchive = async () => {
    setMoreAnchor(null);
    setLoading(true);
    try {
      const result = await bulkArchive({ circleId, ids });
      onSuccess(`Archived ${result.archived} item${result.archived !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to archive items');
    } finally {
      setLoading(false);
    }
  };

  const handleUnarchive = async () => {
    setMoreAnchor(null);
    setLoading(true);
    try {
      const result = await bulkUnarchive({ circleId, ids });
      onSuccess(`Unarchived ${result.unarchived} item${result.unarchived !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to unarchive items');
    } finally {
      setLoading(false);
    }
  };

  // --- Bulk enrichment reruns (thumbnails / faces / AI tagging) ---

  const runRerunThumbnails = async () => {
    setLoading(true);
    try {
      const result = await bulkRerunThumbnails({ circleId, ids });
      onSuccess(`Queued thumbnail refresh for ${result.queued} item${result.queued !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to queue thumbnail refresh');
    } finally {
      setLoading(false);
    }
  };

  const runRerunFaces = async () => {
    setLoading(true);
    try {
      const result = await bulkRerunFaces({ circleId, ids });
      onSuccess(`Queued face detection for ${result.queued} item${result.queued !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to queue face detection');
    } finally {
      setLoading(false);
    }
  };

  const runRerunTags = async () => {
    setLoading(true);
    try {
      const result = await bulkRerunTags({ circleId, ids });
      onSuccess(`Queued AI tagging for ${result.queued} item${result.queued !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to queue AI tagging');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Fire a rerun action. For large selections (>25) open a confirm dialog first;
   * otherwise run immediately. Always closes the overflow menu.
   */
  const runRerun = (label: string, fn: () => void) => {
    setMoreAnchor(null);
    if (count > 25) {
      setConfirm({ label, run: fn });
    } else {
      fn();
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
                {loading ? <CircularProgress size={20} /> : <StarBorderIcon />}
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
        <MenuItem onClick={() => { setMoreAnchor(null); onOpenDate(); }}>
          <ListItemIcon><EditCalendarIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Set date taken</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { setMoreAnchor(null); onOpenTags(); }}>
          <ListItemIcon><LabelIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Edit tags</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => runRerun('thumbnail refresh', () => void runRerunThumbnails())}>
          <ListItemIcon><PhotoSizeSelectActualIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Refresh thumbnails</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => runRerun('face detection', () => void runRerunFaces())}>
          <ListItemIcon><FaceIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Re-run faces</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => runRerun('AI tagging', () => void runRerunTags())}>
          <ListItemIcon><AutoAwesomeIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Re-run AI tagging</ListItemText>
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
        {mode === 'home' && (
          <MenuItem onClick={() => void handleArchive()}>
            <ListItemIcon><ArchiveIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Archive</ListItemText>
          </MenuItem>
        )}
        {mode === 'archive' && (
          <MenuItem onClick={() => void handleUnarchive()}>
            <ListItemIcon><UnarchiveIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Unarchive</ListItemText>
          </MenuItem>
        )}
        <MenuItem onClick={() => { setMoreAnchor(null); setDeleteConfirmOpen(true); }} sx={{ color: 'error.main' }}>
          <ListItemIcon><DeleteIcon fontSize="small" sx={{ color: 'error.main' }} /></ListItemIcon>
          <ListItemText>Move to Trash</ListItemText>
        </MenuItem>
      </Menu>

      {/* Move to Trash confirm */}
      <Dialog open={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Move {count} item{count !== 1 ? 's' : ''} to Trash?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {count} selected item{count !== 1 ? 's' : ''} will be moved to Trash. You can restore
            them within the retention period.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
          <Button onClick={() => void handleDelete()} color="error" variant="contained">
            Move to Trash
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk rerun confirm (large selections) */}
      <Dialog open={Boolean(confirm)} onClose={() => setConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle>
          Re-run {confirm?.label} on {count} item{count !== 1 ? 's' : ''}?
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Re-run {confirm?.label} on {count} item{count !== 1 ? 's' : ''}? They&apos;ll process in
            the background.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            onClick={() => {
              const run = confirm?.run;
              setConfirm(null);
              run?.();
            }}
            variant="contained"
          >
            Re-run
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
