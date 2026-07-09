/**
 * AlbumPage — detail view for a single album at /albums/:albumId.
 *
 * Owns:
 * - Back link to /albums
 * - Album title + optional description (loaded via getAlbum)
 * - Icon toolbar: Map, Slideshow, People, Share
 * - Kebab menu (non-viewers): Select album cover / Rename / Delete album
 * - Rename (PATCH) and Delete (DELETE → navigate /albums) dialogs
 * - MediaGallery in FEED + album mode for the album's media items
 * - A dedicated fullscreen slideshow (MediaLightbox with autoPlay)
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
  Stack,
  Tooltip,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  MoreVert as MoreVertIcon,
  Share as ShareIcon,
  Map as MapIcon,
  Slideshow as SlideshowIcon,
  People as PeopleIcon,
  Image as ImageIcon,
} from '@mui/icons-material';
import { useParams, useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { getAlbum, updateAlbum, deleteAlbum } from '../../services/media';
import type { MediaItem } from '../../types/media';
import { MediaGallery } from '../../components/media/MediaGallery';
import { MediaLightbox } from '../../components/media/MediaLightbox';
import { ShareDialog } from '../../components/share/ShareDialog';
import { AlbumMapDialog } from '../../components/album/AlbumMapDialog';
import { AlbumPeopleDialog } from '../../components/album/AlbumPeopleDialog';
import { SelectAlbumCoverDialog } from '../../components/album/SelectAlbumCoverDialog';

export default function AlbumPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const { activeCircle, activeCircleRole } = useCircle();

  const canManage = activeCircleRole !== 'viewer';

  // Album metadata
  const [albumName, setAlbumName] = useState<string | null>(null);
  const [albumDescription, setAlbumDescription] = useState<string | null>(null);
  const [albumItems, setAlbumItems] = useState<MediaItem[]>([]);
  const [coverMediaItemId, setCoverMediaItemId] = useState<string | null>(null);
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

  // Map / People / Cover dialogs
  const [mapOpen, setMapOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);

  // Slideshow lightbox — null = closed. Self-contained; does not fight the
  // MediaGallery's own lightbox.
  const [slideshowIndex, setSlideshowIndex] = useState<number | null>(null);

  // Gallery refresh token — incrementing causes MediaGallery to re-fetch album header
  const [headerRefreshToken, setHeaderRefreshToken] = useState(0);

  // Load album metadata + items
  useEffect(() => {
    if (!albumId) return;
    setAlbumHeaderLoading(true);
    setAlbumHeaderError(null);
    getAlbum(albumId)
      .then((detail) => {
        setAlbumName(detail.name);
        setAlbumDescription(detail.description);
        setAlbumItems(detail.items ?? []);
        setCoverMediaItemId(detail.coverMediaItemId ?? null);
      })
      .catch((err) => {
        setAlbumHeaderError(err instanceof Error ? err.message : 'Failed to load album');
        setAlbumName(null);
        setAlbumDescription(null);
        setAlbumItems([]);
        setCoverMediaItemId(null);
      })
      .finally(() => setAlbumHeaderLoading(false));
  }, [albumId, headerRefreshToken]);

  const reloadAlbumHeader = useCallback(() => {
    setHeaderRefreshToken((t) => t + 1);
  }, []);

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

  // Persist the chosen album cover, then reload the header so it reflects.
  const handleSaveCover = useCallback(
    async (mediaItemId: string) => {
      if (!albumId) return;
      await updateAlbum(albumId, { coverMediaItemId: mediaItemId });
      reloadAlbumHeader();
    },
    [albumId, reloadAlbumHeader],
  );

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

  const isEmpty = albumItems.length === 0;

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

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mb: 0.5,
            flexWrap: 'wrap',
          }}
        >
          {albumHeaderLoading ? (
            <CircularProgress size={20} />
          ) : (
            <Typography variant="h5" component="h1" sx={{ flexShrink: 1, minWidth: 0 }} noWrap>
              {albumName ?? 'Album'}
            </Typography>
          )}

          {/* Right-aligned icon toolbar */}
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ ml: 'auto', alignItems: 'center', flexShrink: 0 }}
          >
            <Tooltip title="Map">
              <span>
                <IconButton
                  size="small"
                  onClick={() => setMapOpen(true)}
                  disabled={isEmpty}
                  aria-label="View album on map"
                >
                  <MapIcon />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="Slideshow">
              <span>
                <IconButton
                  size="small"
                  onClick={() => setSlideshowIndex(0)}
                  disabled={isEmpty}
                  aria-label="Play slideshow"
                >
                  <SlideshowIcon />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="People">
              <span>
                <IconButton
                  size="small"
                  onClick={() => setPeopleOpen(true)}
                  disabled={isEmpty}
                  aria-label="People in this album"
                >
                  <PeopleIcon />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title="Share album">
              <IconButton
                size="small"
                onClick={() => setShareDialogOpen(true)}
                aria-label="Share album"
              >
                <ShareIcon />
              </IconButton>
            </Tooltip>

            {/* Album management menu — collaborators and above only */}
            {canManage && (
              <>
                <Tooltip title="More actions">
                  <IconButton
                    size="small"
                    onClick={(e) => setMenuAnchor(e.currentTarget)}
                    aria-label="Album actions"
                  >
                    <MoreVertIcon />
                  </IconButton>
                </Tooltip>
                <Menu
                  anchorEl={menuAnchor}
                  open={Boolean(menuAnchor)}
                  onClose={() => setMenuAnchor(null)}
                >
                  <MenuItem
                    disabled={isEmpty}
                    onClick={() => {
                      setMenuAnchor(null);
                      setCoverOpen(true);
                    }}
                  >
                    <ImageIcon fontSize="small" sx={{ mr: 1 }} />
                    Select album cover
                  </MenuItem>
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
                      setDeleteConfirmOpen(true);
                    }}
                    sx={{ color: 'error.main' }}
                  >
                    Delete album
                  </MenuItem>
                </Menu>
              </>
            )}
          </Stack>
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

      {/* Slideshow — dedicated fullscreen lightbox seeded with the album items */}
      {slideshowIndex !== null && albumItems.length > 0 && (
        <MediaLightbox
          items={albumItems}
          index={slideshowIndex}
          onIndexChange={(i) => setSlideshowIndex(i)}
          onClose={() => setSlideshowIndex(null)}
          onOpenProperties={() => {
            /* properties panel is not surfaced in slideshow mode */
          }}
          autoPlay
        />
      )}

      {/* Map dialog */}
      <AlbumMapDialog
        open={mapOpen}
        onClose={() => setMapOpen(false)}
        albumId={albumId}
        circleId={activeCircle.id}
      />

      {/* People dialog */}
      <AlbumPeopleDialog
        open={peopleOpen}
        onClose={() => setPeopleOpen(false)}
        albumId={albumId}
        circleId={activeCircle.id}
      />

      {/* Select album cover dialog */}
      <SelectAlbumCoverDialog
        open={coverOpen}
        onClose={() => setCoverOpen(false)}
        items={albumItems}
        currentCoverMediaItemId={coverMediaItemId}
        onSave={handleSaveCover}
      />

      {/* Share dialog */}
      <ShareDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        target={{ type: 'album', id: albumId }}
      />

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
