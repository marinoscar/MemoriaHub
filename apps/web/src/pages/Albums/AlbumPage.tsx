/**
 * AlbumPage — detail view for a single album at /albums/:albumId.
 *
 * Owns:
 * - Back link to /albums
 * - Album title + optional description (loaded via getAlbum)
 * - Rename (PATCH) and Delete (DELETE → navigate /albums) dialogs
 * - MediaGallery in FEED + album mode for the album's media items
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box,
  Typography,
  Button,
  IconButton,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Menu,
  MenuItem,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  MoreVert as MoreVertIcon,
  Share as ShareIcon,
} from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { getAlbum, updateAlbum, deleteAlbum } from '../../services/media';
import { MediaGallery } from '../../components/media/MediaGallery';
import { ShareDialog } from '../../components/share/ShareDialog';

export default function AlbumPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const { activeCircle, activeCircleRole } = useCircle();

  // Album metadata
  const [albumName, setAlbumName] = useState<string | null>(null);
  const [albumDescription, setAlbumDescription] = useState<string | null>(null);
  const [albumHeaderLoading, setAlbumHeaderLoading] = useState(false);
  const [albumHeaderError, setAlbumHeaderError] = useState<string | null>(null);

  // Actions menu
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

  // Rename dialog
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameNameValue, setRenameNameValue] = useState('');
  const [renameDescValue, setRenameDescValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Delete dialog
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Share dialog
  const [shareDialogOpen, setShareDialogOpen] = useState(false);

  // Gallery refresh token — incrementing causes MediaGallery to re-fetch album header
  const [headerRefreshToken, setHeaderRefreshToken] = useState(0);

  // Load album metadata
  useEffect(() => {
    if (!albumId) return;
    setAlbumHeaderLoading(true);
    setAlbumHeaderError(null);
    getAlbum(albumId)
      .then((detail) => {
        setAlbumName(detail.name);
        setAlbumDescription(detail.description);
      })
      .catch((err) => {
        setAlbumHeaderError(err instanceof Error ? err.message : 'Failed to load album');
        setAlbumName(null);
        setAlbumDescription(null);
      })
      .finally(() => setAlbumHeaderLoading(false));
  }, [albumId, headerRefreshToken]);

  const handleRename = async () => {
    if (!albumId || !renameNameValue.trim()) return;
    setRenameLoading(true);
    setRenameError(null);
    try {
      await updateAlbum(albumId, {
        name: renameNameValue.trim(),
        description: renameDescValue.trim() || null,
      });
      setAlbumName(renameNameValue.trim());
      setAlbumDescription(renameDescValue.trim() || null);
      setRenameOpen(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename album');
    } finally {
      setRenameLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!albumId) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await deleteAlbum(albumId);
      navigate('/albums');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete album');
      setDeleteConfirmOpen(false);
    } finally {
      setDeleteLoading(false);
    }
  };

  const reloadAlbumHeader = useCallback(() => {
    setHeaderRefreshToken((t) => t + 1);
  }, []);

  const queryParams = useMemo(
    () =>
      activeCircle && albumId
        ? {
            circleId: activeCircle.id,
            albumId,
            sortBy: 'capturedAt' as const,
            sortOrder: 'desc' as const,
          }
        : undefined,
    [activeCircle, albumId],
  );

  if (!albumId) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">Album not found.</Alert>
      </Box>
    );
  }

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view this album.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', pb: { xs: 10, sm: 4 } }}>
      {/* Album chrome */}
      <Box sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 3 }, pb: 1 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/albums')}
          size="small"
          sx={{ mb: 0.5 }}
        >
          Albums
        </Button>

        {albumHeaderError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {albumHeaderError}
          </Alert>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          {albumHeaderLoading ? (
            <CircularProgress size={20} />
          ) : (
            <Typography variant="h5" component="h1">
              {albumName ?? 'Album'}
            </Typography>
          )}

          {/* Album actions menu — visible to collaborators and above */}
          {activeCircleRole !== 'viewer' && (
            <>
              <IconButton
                size="small"
                onClick={(e) => {
                  setRenameNameValue(albumName ?? '');
                  setRenameDescValue(albumDescription ?? '');
                  setMenuAnchor(e.currentTarget);
                }}
                aria-label="Album actions"
              >
                <MoreVertIcon />
              </IconButton>
              <Menu
                anchorEl={menuAnchor}
                open={Boolean(menuAnchor)}
                onClose={() => setMenuAnchor(null)}
              >
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    setRenameNameValue(albumName ?? '');
                    setRenameDescValue(albumDescription ?? '');
                    setRenameOpen(true);
                  }}
                >
                  Rename
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    setShareDialogOpen(true);
                  }}
                >
                  <ShareIcon fontSize="small" sx={{ mr: 1 }} />
                  Share album
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    setDeleteConfirmOpen(true);
                  }}
                  sx={{ color: 'error.main' }}
                >
                  Delete album
                </MenuItem>
              </Menu>
            </>
          )}
        </Box>

        {albumDescription && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {albumDescription}
          </Typography>
        )}
      </Box>

      {/* Gallery */}
      {queryParams && (
        <MediaGallery
          circleId={activeCircle.id}
          activeCircleRole={activeCircleRole}
          queryParams={queryParams}
          albumId={albumId}
          emptyState={
            <Box sx={{ textAlign: 'center', py: 8, px: 3 }}>
              <Typography variant="h6" color="text.secondary">
                No photos in this album yet
              </Typography>
            </Box>
          }
          onChange={reloadAlbumHeader}
        />
      )}

      {/* Share dialog */}
      {albumId && (
        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          target={{ type: 'album', id: albumId }}
        />
      )}

      {/* Rename dialog */}
      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Rename Album</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Album name"
            value={renameNameValue}
            onChange={(e) => setRenameNameValue(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
            disabled={renameLoading}
          />
          <TextField
            fullWidth
            size="small"
            label="Description (optional)"
            value={renameDescValue}
            onChange={(e) => setRenameDescValue(e.target.value)}
            multiline
            rows={2}
            disabled={renameLoading}
          />
          {renameError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {renameError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameOpen(false)} disabled={renameLoading}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleRename()}
            disabled={!renameNameValue.trim() || renameLoading}
            startIcon={renameLoading ? <CircularProgress size={16} /> : undefined}
          >
            {renameLoading ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete Album?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Delete album <strong>{albumName}</strong>? The photos will not be deleted.
          </Typography>
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)} disabled={deleteLoading}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={deleteLoading}
            startIcon={deleteLoading ? <CircularProgress size={16} /> : undefined}
          >
            {deleteLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
