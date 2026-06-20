import { useState } from 'react';
import {
  Box,
  Button,
  Typography,
  Stack,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
} from '@mui/material';
import {
  LocationOn as LocationOnIcon,
  Label as LabelIcon,
  Delete as DeleteIcon,
  Star as StarIcon,
  Category as CategoryIcon,
  Close as CloseIcon,
  PhotoAlbum as PhotoAlbumIcon,
  RemoveCircleOutlined as RemoveCircleOutlineIcon,
} from '@mui/icons-material';
import type { CircleRole } from '../../types/circles';
import type { MediaClassification } from '../../types/media';
import { bulkUpdateMedia, bulkDelete } from '../../services/media';

interface BulkActionToolbarProps {
  selected: Set<string>;
  circleId: string;
  activeCircleRole: CircleRole | null;
  onClear: () => void;
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
  onOpenLocation,
  onOpenTags,
  onSuccess,
  onError,
  onOpenAlbum,
  albumMode,
  onRemoveFromAlbum,
}: BulkActionToolbarProps) {
  const [classifyAnchor, setClassifyAnchor] = useState<null | HTMLElement>(null);
  const [favoriteAnchor, setFavoriteAnchor] = useState<null | HTMLElement>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const isViewer = activeCircleRole === 'viewer';
  const ids = Array.from(selected);
  const count = ids.length;

  if (count === 0) return null;

  const handleClassify = async (classification: MediaClassification) => {
    setClassifyAnchor(null);
    setLoading(true);
    try {
      const result = await bulkUpdateMedia({ circleId, ids, set: { classification } });
      onSuccess(`Updated classification for ${result.updated} item${result.updated !== 1 ? 's' : ''}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update classification');
    } finally {
      setLoading(false);
    }
  };

  const handleFavorite = async (favorite: boolean) => {
    setFavoriteAnchor(null);
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
          bottom: 80,
          zIndex: 1200,
          mx: { xs: -2, md: -3 },
          px: { xs: 2, md: 3 },
          py: 1,
          backgroundColor: 'primary.main',
          color: 'primary.contrastText',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
          boxShadow: 4,
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600, mr: 1 }}>
          {count} selected
        </Typography>

        <Button
          size="small"
          variant="text"
          sx={{ color: 'inherit', minHeight: 44 }}
          startIcon={<CloseIcon />}
          onClick={onClear}
        >
          Clear
        </Button>

        {!isViewer && (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            <Button
              size="small"
              variant="outlined"
              sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
              startIcon={<LocationOnIcon />}
              onClick={onOpenLocation}
              disabled={loading}
            >
              Set Location
            </Button>

            <Button
              size="small"
              variant="outlined"
              sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
              startIcon={<LabelIcon />}
              onClick={onOpenTags}
              disabled={loading}
            >
              Tags
            </Button>

            {onOpenAlbum && (
              <Button
                size="small"
                variant="outlined"
                sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
                startIcon={<PhotoAlbumIcon />}
                onClick={onOpenAlbum}
                disabled={loading}
              >
                Add to Album
              </Button>
            )}

            {albumMode && onRemoveFromAlbum && (
              <Button
                size="small"
                variant="outlined"
                sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
                startIcon={<RemoveCircleOutlineIcon />}
                onClick={onRemoveFromAlbum}
                disabled={loading}
              >
                Remove from Album
              </Button>
            )}

            <Button
              size="small"
              variant="outlined"
              sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
              startIcon={loading ? <CircularProgress size={14} sx={{ color: 'inherit' }} /> : <CategoryIcon />}
              onClick={(e) => setClassifyAnchor(e.currentTarget)}
              disabled={loading}
            >
              Classification
            </Button>

            <Button
              size="small"
              variant="outlined"
              sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
              startIcon={<StarIcon />}
              onClick={(e) => setFavoriteAnchor(e.currentTarget)}
              disabled={loading}
            >
              Favorite
            </Button>

            <Button
              size="small"
              variant="outlined"
              sx={{ color: 'inherit', borderColor: 'rgba(255,255,255,0.5)', minHeight: 44 }}
              startIcon={<DeleteIcon />}
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={loading}
            >
              Delete
            </Button>
          </Stack>
        )}
      </Box>

      {/* Classification menu */}
      <Menu
        anchorEl={classifyAnchor}
        open={Boolean(classifyAnchor)}
        onClose={() => setClassifyAnchor(null)}
      >
        <MenuItem onClick={() => void handleClassify('memory')}>Memory</MenuItem>
        <MenuItem onClick={() => void handleClassify('low_value')}>Low Value</MenuItem>
        <MenuItem onClick={() => void handleClassify('unreviewed')}>Unreviewed</MenuItem>
      </Menu>

      {/* Favorite menu */}
      <Menu
        anchorEl={favoriteAnchor}
        open={Boolean(favoriteAnchor)}
        onClose={() => setFavoriteAnchor(null)}
      >
        <MenuItem onClick={() => void handleFavorite(true)}>Add to Favorites</MenuItem>
        <MenuItem onClick={() => void handleFavorite(false)}>Remove from Favorites</MenuItem>
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
