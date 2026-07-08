import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  IconButton,
  Typography,
  CircularProgress,
  Stack,
  Tooltip,
  Popover,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Snackbar,
  Alert,
  useMediaQuery,
} from '@mui/material';
import {
  Close as CloseIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  Download as DownloadIcon,
  InfoOutlined,
  IosShare as IosShareIcon,
  Tune as TuneIcon,
  Archive as ArchiveIcon,
  Unarchive as UnarchiveIcon,
  Delete as DeleteIcon,
  MoreVert as MoreVertIcon,
  Add as AddIcon,
  LocalOffer as LocalOfferIcon,
  Face as FaceIcon,
  InfoOutlined as InfoOutlinedIcon,
  Refresh as RefreshIcon,
  ChevronLeft,
  ChevronRight,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { MediaItem } from '../../types/media';
import {
  getMedia,
  patchMedia as patchMediaApi,
  bulkArchive,
  bulkUnarchive,
  bulkDelete,
} from '../../services/media';
import { rerunMediaFaces } from '../../services/face';
import { rerunThumbnail } from '../../services/thumbnail';
import { useMediaTags } from '../../hooks/useMediaTags';
import { useMediaMetadata } from '../../hooks/useMediaMetadata';
import { SharePanel } from '../share/SharePanel';
import { AddToAlbumDialog } from '../album/AddToAlbumDialog';
import { MediaOrientationEditor } from './MediaOrientationEditor';
import { VideoPlayer } from './VideoPlayer';

// ---------------------------------------------------------------------------
// Module-scope cache so full items survive lightbox close/reopen
// ---------------------------------------------------------------------------

const fullItemCache = new Map<string, MediaItem>();

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MediaLightboxProps {
  items: MediaItem[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  onOpenProperties: (item: MediaItem) => void;
  onItemUpdated?: (updated: MediaItem) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
  onOpenProperties,
  onItemUpdated,
}: MediaLightboxProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const item = index !== null ? items[index] ?? null : null;

  // Full item (with downloadUrl) fetched from API
  const [fullItem, setFullItem] = useState<MediaItem | null>(null);
  // True once the full-res image has loaded in the browser
  const [fullResLoaded, setFullResLoaded] = useState(false);
  // Zoom state — added in commit 7
  const [zoomed, setZoomed] = useState(false);
  // Controls visibility — added in commit 4
  const [controlsVisible, setControlsVisible] = useState(true);

  // Immich-style action bar surfaces
  const [shareAnchor, setShareAnchor] = useState<null | HTMLElement>(null);
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [addAlbumOpen, setAddAlbumOpen] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [facesLoading, setFacesLoading] = useState(false);
  const [thumbLoading, setThumbLoading] = useState(false);
  const [snack, setSnack] = useState<{
    message: string;
    severity: 'success' | 'error';
  } | null>(null);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeRef = useRef<{
    startX: number;
    startY: number;
    deltaX: number;
    deltaY: number;
    swiping: boolean;
  }>({ startX: 0, startY: 0, deltaX: 0, deltaY: 0, swiping: false });

  // --- Mobile auto-hide controls ---
  const resetHideTimer = useCallback(() => {
    if (!isMobile) return;
    setControlsVisible(true);
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, [isMobile]);

  // Start auto-hide on mobile when lightbox opens
  useEffect(() => {
    if (isMobile && index !== null) {
      resetHideTimer();
    }
    return () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    };
  }, [isMobile, index, resetHideTimer]);

  // --- Favorite toggle ---
  const handleToggleFavorite = useCallback(async () => {
    if (!item) return;
    try {
      const updated = await patchMediaApi(item.id, { favorite: !item.favorite });
      // Update cache
      if (fullItemCache.has(item.id)) {
        fullItemCache.set(item.id, {
          ...fullItemCache.get(item.id)!,
          favorite: updated.favorite,
        });
      }
      if (fullItem) {
        setFullItem((prev) => (prev ? { ...prev, favorite: updated.favorite } : prev));
      }
      onItemUpdated?.(updated);
    } catch {
      // Silently fail
    }
  }, [item, fullItem, onItemUpdated]);

  // --- Refetch the full item (fresh signed URLs) and propagate upward ---
  // Busts the module cache, updates local state, and forces the full-res <img>
  // to reload. Used by the orientation editor and the refresh overflow actions.
  const refreshFullItem = useCallback(async () => {
    if (!item) return;
    try {
      fullItemCache.delete(item.id);
      const refreshed = await getMedia(item.id);
      fullItemCache.set(refreshed.id, refreshed);
      setFullItem(refreshed);
      setFullResLoaded(false);
      onItemUpdated?.(refreshed);
    } catch {
      // Silently swallow — the previous item remains displayed
    }
  }, [item?.id, onItemUpdated]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tagging / metadata rerun hooks (poll to completion, then refresh the item)
  const { rerun: rerunTags, rerunLoading: rerunTagsLoading } = useMediaTags(
    item?.id ?? '',
    () => void refreshFullItem(),
  );
  const { rerun: rerunMetadata, rerunLoading: rerunMetadataLoading } = useMediaMetadata(
    item?.id ?? '',
    () => void refreshFullItem(),
  );

  // --- Archive / unarchive toggle ---
  const handleToggleArchive = useCallback(async () => {
    if (!item) return;
    setArchiveLoading(true);
    try {
      const isArchived = ((fullItem ?? item).archivedAt ?? null) !== null;
      if (isArchived) {
        await bulkUnarchive({ circleId: item.circleId, ids: [item.id] });
      } else {
        await bulkArchive({ circleId: item.circleId, ids: [item.id] });
      }
      const refreshed = await getMedia(item.id);
      fullItemCache.set(refreshed.id, refreshed);
      setFullItem(refreshed);
      onItemUpdated?.(refreshed);
      setSnack({
        message: isArchived ? 'Item unarchived' : 'Item archived',
        severity: 'success',
      });
    } catch (err) {
      setSnack({
        message: err instanceof Error ? err.message : 'Failed to update archive state',
        severity: 'error',
      });
    } finally {
      setArchiveLoading(false);
    }
  }, [item, fullItem, onItemUpdated]);

  // --- Move to Trash ---
  const handleDelete = useCallback(async () => {
    if (!item) return;
    setDeleteConfirmOpen(false);
    setDeleteLoading(true);
    try {
      await bulkDelete({ circleId: item.circleId, ids: [item.id] });
      onClose();
    } catch (err) {
      setSnack({
        message: err instanceof Error ? err.message : 'Failed to move item to Trash',
        severity: 'error',
      });
    } finally {
      setDeleteLoading(false);
    }
  }, [item, onClose]);

  // --- Overflow: refresh faces (async job — no polling) ---
  const handleRefreshFaces = useCallback(async () => {
    if (!item) return;
    setMoreAnchor(null);
    setFacesLoading(true);
    try {
      await rerunMediaFaces(item.id);
      setSnack({ message: 'Face detection re-queued', severity: 'success' });
    } catch (err) {
      setSnack({
        message: err instanceof Error ? err.message : 'Failed to refresh faces',
        severity: 'error',
      });
    } finally {
      setFacesLoading(false);
    }
  }, [item]);

  // --- Overflow: retry thumbnail (synchronous server-side) ---
  const handleRefreshThumbnail = useCallback(async () => {
    if (!item) return;
    setMoreAnchor(null);
    setThumbLoading(true);
    try {
      await rerunThumbnail(item.id);
      await refreshFullItem();
      setSnack({ message: 'Thumbnail regenerated', severity: 'success' });
    } catch (err) {
      setSnack({
        message: err instanceof Error ? err.message : 'Failed to retry thumbnail',
        severity: 'error',
      });
    } finally {
      setThumbLoading(false);
    }
  }, [item, refreshFullItem]);

  // --- Keyboard navigation ---
  useEffect(() => {
    if (index === null) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index > 0) {
        onIndexChange(index - 1);
      } else if (e.key === 'ArrowRight' && index < items.length - 1) {
        onIndexChange(index + 1);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [index, items.length, onIndexChange, onClose]);

  // --- Swipe handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    swipeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      deltaX: 0,
      deltaY: 0,
      swiping: true,
    };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!swipeRef.current.swiping) return;
    swipeRef.current.deltaX = e.clientX - swipeRef.current.startX;
    swipeRef.current.deltaY = e.clientY - swipeRef.current.startY;
    // Cancel if more vertical than horizontal
    if (Math.abs(swipeRef.current.deltaY) > Math.abs(swipeRef.current.deltaX)) {
      swipeRef.current.swiping = false;
    }
    if (isMobile) resetHideTimer();
  }, [isMobile, resetHideTimer]);

  const handlePointerUp = useCallback(() => {
    const { swiping, deltaX, deltaY } = swipeRef.current;
    swipeRef.current.swiping = false;
    if (swiping && Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX > 0 && index !== null && index > 0) {
        onIndexChange(index - 1);
      } else if (deltaX < 0 && index !== null && index < items.length - 1) {
        onIndexChange(index + 1);
      }
    }
  }, [index, items.length, onIndexChange]);

  // --- Fetch full item & prefetch neighbors ---
  useEffect(() => {
    if (index === null || !item) {
      setFullItem(null);
      setFullResLoaded(false);
      return;
    }

    // Reset per-item state
    setFullResLoaded(false);
    setZoomed(false);

    // Check cache first
    const cached = fullItemCache.get(item.id);
    if (cached) {
      setFullItem(cached);
      setFullResLoaded(true);
    } else {
      // Start with null so thumbnail blur shows while loading
      setFullItem(null);
      getMedia(item.id)
        .then((fetched) => {
          fullItemCache.set(fetched.id, fetched);
          setFullItem(fetched);
        })
        .catch(() => {
          // Silently fail — thumbnail remains visible
        });
    }

    // Prefetch neighbors (fire and forget)
    if (index > 0) {
      const prev = items[index - 1];
      if (prev && !fullItemCache.has(prev.id)) {
        getMedia(prev.id)
          .then((f) => { fullItemCache.set(f.id, f); })
          .catch(() => {});
      }
    }
    if (index < items.length - 1) {
      const next = items[index + 1];
      if (next && !fullItemCache.has(next.id)) {
        getMedia(next.id)
          .then((f) => { fullItemCache.set(f.id, f); })
          .catch(() => {});
      }
    }
  }, [index, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (index === null || !item) {
    return <Dialog fullScreen open={false} />;
  }

  const displayItem = fullItem ?? item;
  const downloadUrl = displayItem.downloadUrl ?? null;
  const thumbnailUrl = item.thumbnailUrl;

  return (
    <Dialog
      fullScreen
      open={index !== null}
      sx={{ zIndex: 1200 }}
      slotProps={{ paper: { sx: { backgroundColor: 'black', overflow: 'hidden' } } }}
    >
      {/* Backdrop click closes */}
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={onClose}
        onPointerMove={isMobile ? resetHideTimer : undefined}
      >
        {/* Inner content — stop propagation so clicks on controls don't close */}
        <Box
          sx={{ position: 'relative', width: '100%', height: '100%' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Control bar */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              width: '100%',
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(4px)',
              zIndex: 10,
              display: 'flex',
              alignItems: 'center',
              px: 1,
              py: 0.5,
              opacity: controlsVisible ? 1 : 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: controlsVisible ? 'auto' : 'none',
            }}
          >
            <Tooltip title="Close">
              <IconButton
                aria-label="Close lightbox"
                onClick={onClose}
                sx={{ color: 'white' }}
              >
                <CloseIcon />
              </IconButton>
            </Tooltip>

            <Typography
              variant="body2"
              noWrap
              sx={{ color: 'white', flex: 1, textAlign: 'center', mx: 1 }}
            >
              {item.originalFilename}
            </Typography>

            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              {/* 1. Share */}
              <Tooltip title="Share publicly">
                <IconButton
                  aria-label="Share publicly"
                  onClick={(e) => setShareAnchor(e.currentTarget)}
                  sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                >
                  <IosShareIcon />
                </IconButton>
              </Tooltip>

              {/* 2. Download */}
              {downloadUrl && (
                <Tooltip title="Download original">
                  <IconButton
                    component="a"
                    href={downloadUrl}
                    download
                    aria-label="Download original"
                    sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                  >
                    <DownloadIcon />
                  </IconButton>
                </Tooltip>
              )}

              {/* 3. Info */}
              <Tooltip title="Open properties panel">
                <IconButton
                  aria-label="Open properties panel"
                  onClick={() => onOpenProperties(displayItem)}
                  sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                >
                  <InfoOutlined />
                </IconButton>
              </Tooltip>

              {/* 4. Favorite */}
              <Tooltip title={displayItem.favorite ? 'Remove from favorites' : 'Add to favorites'}>
                <IconButton
                  aria-label="Toggle favorite"
                  onClick={() => void handleToggleFavorite()}
                  sx={{
                    color: displayItem.favorite ? theme.palette.warning.main : 'white',
                    minWidth: 44,
                    minHeight: 44,
                  }}
                >
                  {displayItem.favorite ? <StarIcon /> : <StarBorderIcon />}
                </IconButton>
              </Tooltip>

              {/* 5. Edit (photos only) */}
              {displayItem.type === 'photo' && (
                <Tooltip title="Edit orientation">
                  <IconButton
                    aria-label="Edit orientation"
                    onClick={() => setEditorOpen(true)}
                    sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                  >
                    <TuneIcon />
                  </IconButton>
                </Tooltip>
              )}

              {/* 6. Archive / Unarchive */}
              <Tooltip title={displayItem.archivedAt !== null ? 'Unarchive' : 'Archive'}>
                <span>
                  <IconButton
                    aria-label={displayItem.archivedAt !== null ? 'Unarchive' : 'Archive'}
                    onClick={() => void handleToggleArchive()}
                    disabled={archiveLoading}
                    sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                  >
                    {archiveLoading ? (
                      <CircularProgress size={20} sx={{ color: 'white' }} />
                    ) : displayItem.archivedAt !== null ? (
                      <UnarchiveIcon />
                    ) : (
                      <ArchiveIcon />
                    )}
                  </IconButton>
                </span>
              </Tooltip>

              {/* 7. Delete */}
              <Tooltip title="Move to Trash">
                <span>
                  <IconButton
                    aria-label="Move to Trash"
                    onClick={() => setDeleteConfirmOpen(true)}
                    disabled={deleteLoading}
                    sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                  >
                    {deleteLoading ? (
                      <CircularProgress size={20} sx={{ color: 'white' }} />
                    ) : (
                      <DeleteIcon />
                    )}
                  </IconButton>
                </span>
              </Tooltip>

              {/* 8. Overflow */}
              <Tooltip title="More actions">
                <IconButton
                  aria-label="More actions"
                  onClick={(e) => setMoreAnchor(e.currentTarget)}
                  sx={{ color: 'white', minWidth: 44, minHeight: 44 }}
                >
                  <MoreVertIcon />
                </IconButton>
              </Tooltip>
            </Stack>
          </Box>

          {/* Media content */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onClick={isMobile ? () => setControlsVisible((v) => !v) : undefined}
            onDoubleClick={() => setZoomed((z) => !z)}
          >
            {item.type === 'video' ? (
              /* Video branch: show spinner while downloading URL, then VideoPlayer */
              downloadUrl ? (
                <Box sx={{ width: '100%', backgroundColor: 'black' }}>
                  <VideoPlayer
                    src={downloadUrl}
                    poster={thumbnailUrl}
                    title={item.originalFilename}
                  />
                </Box>
              ) : (
                <CircularProgress sx={{ color: 'white' }} />
              )
            ) : (
              /* Photo branch with progressive loading */
              <Box
                sx={{
                  position: 'relative',
                  width: '100%',
                  height: '100%',
                  transform: zoomed ? 'scale(2)' : 'scale(1)',
                  transformOrigin: '50% 50%',
                  transition: 'transform 0.2s ease',
                  cursor: zoomed ? 'zoom-out' : 'zoom-in',
                }}
              >
                {/* Thumbnail (blurred placeholder) */}
                {thumbnailUrl && (
                  <Box
                    component="img"
                    src={thumbnailUrl}
                    alt={item.originalFilename}
                    sx={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      filter: 'blur(8px)',
                      opacity: fullResLoaded ? 0 : 1,
                      transition: 'opacity 0.3s ease',
                    }}
                  />
                )}
                {/* Full resolution image */}
                {fullItem?.downloadUrl && (
                  <Box
                    component="img"
                    src={fullItem.downloadUrl}
                    alt={item.originalFilename}
                    onLoad={() => setFullResLoaded(true)}
                    sx={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      opacity: fullResLoaded ? 1 : 0,
                      transition: 'opacity 0.3s ease',
                    }}
                  />
                )}
              </Box>
            )}
          </Box>

          {/* Left chevron */}
          <IconButton
            aria-label="Previous photo"
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
            sx={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 10,
              color: 'white',
              backgroundColor: 'rgba(0,0,0,0.4)',
              '&:hover': { backgroundColor: 'rgba(0,0,0,0.7)' },
              '&.Mui-disabled': {
                color: 'rgba(255,255,255,0.3)',
                backgroundColor: 'rgba(0,0,0,0.2)',
              },
              opacity: controlsVisible ? 1 : 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: controlsVisible ? 'auto' : 'none',
              minWidth: 44,
              minHeight: 44,
            }}
          >
            <ChevronLeft />
          </IconButton>

          {/* Right chevron */}
          <IconButton
            aria-label="Next photo"
            disabled={index === items.length - 1}
            onClick={() => onIndexChange(index + 1)}
            sx={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 10,
              color: 'white',
              backgroundColor: 'rgba(0,0,0,0.4)',
              '&:hover': { backgroundColor: 'rgba(0,0,0,0.7)' },
              '&.Mui-disabled': {
                color: 'rgba(255,255,255,0.3)',
                backgroundColor: 'rgba(0,0,0,0.2)',
              },
              opacity: controlsVisible ? 1 : 0,
              transition: 'opacity 0.3s ease',
              pointerEvents: controlsVisible ? 'auto' : 'none',
              minWidth: 44,
              minHeight: 44,
            }}
          >
            <ChevronRight />
          </IconButton>
        </Box>
      </Box>

      {/* Share popover — anchored to the share button. Rendered as a single
          nested Modal over the lightbox Dialog (standard MUI stacking). */}
      <Popover
        open={Boolean(shareAnchor)}
        anchorEl={shareAnchor}
        onClose={() => setShareAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        sx={{ zIndex: (t) => t.zIndex.modal + 2 }}
      >
        <Box sx={{ p: 2, width: 320 }} onClick={(e) => e.stopPropagation()}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Share publicly
          </Typography>
          <SharePanel
            target={{ type: 'media_item', id: displayItem.id }}
            onRequestClose={() => setShareAnchor(null)}
          />
        </Box>
      </Popover>

      {/* Overflow menu */}
      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={() => setMoreAnchor(null)}
        sx={{ zIndex: (t) => t.zIndex.modal + 2 }}
      >
        <MenuItem
          onClick={() => {
            setMoreAnchor(null);
            setAddAlbumOpen(true);
          }}
        >
          <ListItemIcon><AddIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Add to album</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={rerunTagsLoading}
          onClick={() => {
            setMoreAnchor(null);
            void rerunTags();
          }}
        >
          <ListItemIcon>
            {rerunTagsLoading ? <CircularProgress size={18} /> : <LocalOfferIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText>Re-run AI tagging</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={facesLoading}
          onClick={() => void handleRefreshFaces()}
        >
          <ListItemIcon>
            {facesLoading ? <CircularProgress size={18} /> : <FaceIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText>Refresh faces</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={rerunMetadataLoading}
          onClick={() => {
            setMoreAnchor(null);
            void rerunMetadata();
          }}
        >
          <ListItemIcon>
            {rerunMetadataLoading ? <CircularProgress size={18} /> : <InfoOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText>Refresh metadata</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={thumbLoading}
          onClick={() => void handleRefreshThumbnail()}
        >
          <ListItemIcon>
            {thumbLoading ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText>Refresh thumbnails</ListItemText>
        </MenuItem>
      </Menu>

      {/* Move to Trash confirm dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
        sx={{ zIndex: (t) => t.zIndex.modal + 3 }}
      >
        <DialogTitle>Move to Trash?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This item will be moved to Trash and can be recovered within the retention period.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)} disabled={deleteLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleDelete()}
            color="error"
            variant="contained"
            disabled={deleteLoading}
          >
            Move to Trash
          </Button>
        </DialogActions>
      </Dialog>

      {/* Orientation editor */}
      <MediaOrientationEditor
        item={displayItem}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onEdited={() => void refreshFullItem()}
      />

      {/* Add to album */}
      <AddToAlbumDialog
        open={addAlbumOpen}
        onClose={() => setAddAlbumOpen(false)}
        circleId={displayItem.circleId}
        selectedIds={[displayItem.id]}
        filters={{ circleId: displayItem.circleId }}
        matchingCount={1}
        onSuccess={(message) => {
          setAddAlbumOpen(false);
          setSnack({ message, severity: 'success' });
        }}
        onError={(message) => setSnack({ message, severity: 'error' })}
      />

      {/* Action feedback */}
      <Snackbar
        open={snack !== null}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ zIndex: (t) => t.zIndex.modal + 4 }}
      >
        {snack ? (
          <Alert
            severity={snack.severity}
            onClose={() => setSnack(null)}
            variant="filled"
            sx={{ width: '100%' }}
          >
            {snack.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Dialog>
  );
}
