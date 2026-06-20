/**
 * MediaGallery — canonical day-grouped infinite grid with multi-select,
 * lightbox, properties drawer, favorite toggle, and bulk actions.
 *
 * Two data-source modes:
 *   FEED mode   (queryParams provided): calls useInfiniteMedia internally,
 *               renders an infinite-scroll sentinel, and resets on bulk success.
 *   CONTROLLED  (items provided): renders the supplied array, no fetching;
 *               uses isLoading for a spinner; calls onChange on bulk success.
 *
 * Album mode is activated by passing albumId.  It adds "Remove from Album"
 * to the BulkActionToolbar and wires onRemoveFromAlbum accordingly.
 */

import { useState, useRef, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Skeleton,
  Button,
  IconButton,
  Tooltip,
  ImageListItem,
  ImageListItemBar,
  CircularProgress,
  Stack,
  Snackbar,
  Alert,
  useMediaQuery,
} from '@mui/material';
import {
  PhotoLibrary as PhotoLibraryIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  CheckBox as CheckBoxIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useInfiniteMedia } from '../../hooks/useInfiniteMedia';
import { useIntersectionObserver } from '../../hooks/useIntersectionObserver';
import { groupByDay } from '../../utils/groupByDay';
import { MediaDetailDrawer } from './MediaDetailDrawer';
import { MediaLightbox } from './MediaLightbox';
import { BulkActionToolbar } from './BulkActionToolbar';
import { BulkLocationDialog } from './BulkLocationDialog';
import { BulkTagsDialog } from './BulkTagsDialog';
import { AddToAlbumDialog } from '../album/AddToAlbumDialog';
import { patchMedia as patchMediaApi, removeAlbumItem } from '../../services/media';
import type { MediaItem, MediaQueryParams } from '../../types/media';
import type { CircleRole } from '../../types/circles';

// ---------------------------------------------------------------------------
// AppBar height constant for sticky day-header offset
// ---------------------------------------------------------------------------

const APP_BAR_HEIGHT = 64;

// ---------------------------------------------------------------------------
// GalleryTile — internal thumbnail tile
// ---------------------------------------------------------------------------

interface GalleryTileProps {
  item: MediaItem;
  onSelect: () => void;
  onToggleFavorite: (item: MediaItem) => void;
  isSelected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string) => void;
  selectionMode: boolean;
}

function GalleryTile({
  item,
  onSelect,
  onToggleFavorite,
  isSelected,
  anySelected,
  onToggleSelect,
  selectionMode,
}: GalleryTileProps) {
  const theme = useTheme();
  const isMobileDevice = useMediaQuery(theme.breakpoints.down('sm'));
  const [imgError, setImgError] = useState(false);

  return (
    <ImageListItem
      onClick={() => {
        if (selectionMode || anySelected) {
          onToggleSelect(item.id);
        } else {
          onSelect();
        }
      }}
      sx={{
        position: 'relative',
        cursor: 'pointer',
        overflow: 'hidden',
        borderRadius: 0.5,
        aspectRatio: '1',
        backgroundColor: theme.palette.grey[900],
        outline: isSelected ? `2px solid ${theme.palette.primary.main}` : 'none',
        outlineOffset: '-2px',
        opacity: isSelected ? 0.85 : 1,
        transition: 'outline 0.1s, opacity 0.1s',
        '&:hover .gallery-tile-overlay': { opacity: 1 },
        '&:hover .gallery-tile-fav': { opacity: 1 },
      }}
    >
      {item.thumbnailUrl && !imgError ? (
        <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
          <Box
            component="img"
            src={item.thumbnailUrl}
            alt={item.title ?? item.originalFilename}
            onError={() => setImgError(true)}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          {item.type === 'video' && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <PlayCircleOutlinedIcon
                sx={{
                  fontSize: 40,
                  color: 'rgba(255,255,255,0.85)',
                  filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))',
                }}
              />
            </Box>
          )}
        </Box>
      ) : !imgError ? (
        /* Awaiting thumbnail enrichment */
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <Skeleton
            variant="rectangular"
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
          <CircularProgress size={24} sx={{ position: 'relative', zIndex: 1 }} />
        </Box>
      ) : (
        /* Broken / missing image */
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PhotoLibraryIcon sx={{ fontSize: 36, color: theme.palette.grey[600] }} />
        </Box>
      )}

      {/* Selection checkbox */}
      <Box
        className="select-overlay"
        sx={{
          position: 'absolute',
          top: 4,
          left: 4,
          zIndex: 2,
          opacity: isMobileDevice || selectionMode || anySelected || isSelected ? 1 : 0,
          transition: 'opacity 0.15s',
          '.MuiImageListItem-root:hover &': { opacity: 1 },
        }}
      >
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(item.id);
          }}
          aria-label={isSelected ? 'Deselect item' : 'Select item'}
          sx={{
            color: isSelected ? 'primary.main' : 'white',
            backgroundColor: 'rgba(0,0,0,0.4)',
            '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
            p: { xs: 0.5, sm: 0.25 },
          }}
        >
          {isSelected ? (
            <CheckBoxIcon fontSize="small" />
          ) : (
            <CheckBoxOutlineBlankIcon fontSize="small" />
          )}
        </IconButton>
      </Box>

      {/* Gradient overlay — always visible when favorited */}
      <Box
        className="gallery-tile-overlay"
        sx={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 50%)',
          opacity: item.favorite ? 1 : 0,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
        }}
      />

      {/* Favorite toggle */}
      <ImageListItemBar
        className="gallery-tile-fav"
        sx={{
          background: 'transparent',
          opacity: item.favorite ? 1 : 0,
          transition: 'opacity 0.2s',
          '& .MuiImageListItemBar-titleWrap': { display: 'none' },
          '.MuiImageListItem-root:hover &': { opacity: 1 },
        }}
        actionIcon={
          <Tooltip title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(item);
              }}
              aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
              sx={{ color: item.favorite ? 'warning.main' : 'white', p: { xs: 1, sm: 0.5 } }}
            >
              {item.favorite ? <StarIcon /> : <StarBorderIcon />}
            </IconButton>
          </Tooltip>
        }
        position="top"
        actionPosition="right"
      />
    </ImageListItem>
  );
}

// ---------------------------------------------------------------------------
// MediaGalleryProps
// ---------------------------------------------------------------------------

export interface MediaGalleryProps {
  circleId: string;
  activeCircleRole: CircleRole | null;

  /** FEED mode: component calls useInfiniteMedia with these params. */
  queryParams?: MediaQueryParams;
  /** CONTROLLED mode: render this array directly, no fetching. */
  items?: MediaItem[];
  /** Controlled-mode loading flag — shows a centered spinner when true. */
  isLoading?: boolean;
  /** Feed mode page size (default 50). */
  pageSize?: number;
  /**
   * Album mode: enables "Remove from Album" in BulkActionToolbar and derives
   * AddToAlbum filters that exclude the current albumId.
   */
  albumId?: string;
  /** Shown when the item list is empty. */
  emptyState?: React.ReactNode;
  /**
   * Called after any mutating bulk action so parents can refresh external
   * state (e.g. album header, search result counts).
   */
  onChange?: () => void;
}

// ---------------------------------------------------------------------------
// MediaGallery
// ---------------------------------------------------------------------------

export function MediaGallery({
  circleId,
  activeCircleRole,
  queryParams,
  items: controlledItems,
  isLoading: controlledLoading,
  pageSize = 50,
  albumId,
  emptyState,
  onChange,
}: MediaGalleryProps) {
  const theme = useTheme();

  // Determine mode
  const isFeedMode = queryParams !== undefined;

  // -------------------------------------------------------------------------
  // FEED mode — infinite scroll via useInfiniteMedia
  // -------------------------------------------------------------------------

  const feedResult = useInfiniteMedia(
    // Always call the hook (rules of hooks); pass empty params in controlled mode
    isFeedMode ? queryParams : {},
    pageSize,
    isFeedMode && !!circleId,
  );

  const feedItems = feedResult.items;
  const feedIsLoading = feedResult.isLoading;
  const feedError = feedResult.error;
  const feedHasMore = feedResult.hasMore;
  const feedLoadMore = feedResult.loadMore;
  const feedReset = feedResult.reset;

  // Infinite scroll sentinel
  const sentinelRef = useRef<HTMLDivElement>(null);
  useIntersectionObserver(sentinelRef, feedLoadMore, {
    rootMargin: '300px',
    disabled: !isFeedMode || !feedHasMore || feedIsLoading || !circleId,
  });

  // -------------------------------------------------------------------------
  // Unified item list (either feed or controlled)
  // -------------------------------------------------------------------------

  const baseItems: MediaItem[] = isFeedMode ? feedItems : (controlledItems ?? []);
  const isLoading: boolean = isFeedMode ? feedIsLoading : (controlledLoading ?? false);
  const error: string | null = isFeedMode ? feedError : null;

  // -------------------------------------------------------------------------
  // Optimistic patches for favorite toggles
  // -------------------------------------------------------------------------

  const [localPatches, setLocalPatches] = useState<Record<string, Partial<MediaItem>>>({});

  const mergedItems = useMemo(
    () =>
      baseItems.map((item) =>
        localPatches[item.id] ? { ...item, ...localPatches[item.id] } : item,
      ),
    [baseItems, localPatches],
  );

  const grouped = useMemo(() => groupByDay(mergedItems), [mergedItems]);

  // -------------------------------------------------------------------------
  // Lightbox + detail drawer
  // -------------------------------------------------------------------------

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleItemUpdated = useCallback((updated: MediaItem) => {
    setLocalPatches((prev) => ({ ...prev, [updated.id]: updated }));
  }, []);

  // -------------------------------------------------------------------------
  // Favorite toggle (optimistic)
  // -------------------------------------------------------------------------

  const handleToggleFavorite = useCallback(async (item: MediaItem) => {
    const next = !item.favorite;
    setLocalPatches((prev) => ({ ...prev, [item.id]: { favorite: next } }));
    try {
      await patchMediaApi(item.id, { favorite: next });
    } catch {
      // Rollback
      setLocalPatches((prev) => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
    }
  }, []);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

  const handleToggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectionMode(false);
  }, []);

  // -------------------------------------------------------------------------
  // Snackbar
  // -------------------------------------------------------------------------

  const [snackbar, setSnackbar] = useState<{
    message: string;
    severity: 'success' | 'error';
  } | null>(null);

  // -------------------------------------------------------------------------
  // Bulk dialogs
  // -------------------------------------------------------------------------

  const [bulkLocationOpen, setBulkLocationOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);

  // -------------------------------------------------------------------------
  // Bulk success handler
  // -------------------------------------------------------------------------

  const handleBulkSuccess = useCallback(
    (message: string) => {
      setSnackbar({ message, severity: 'success' });
      setSelected(new Set());
      setSelectionMode(false);
      setLocalPatches({});
      if (isFeedMode) {
        feedReset();
      } else {
        onChange?.();
      }
    },
    [isFeedMode, feedReset, onChange],
  );

  // -------------------------------------------------------------------------
  // Remove from album (album mode only)
  // -------------------------------------------------------------------------

  const handleRemoveFromAlbum = useCallback(async () => {
    if (!albumId || selected.size === 0) return;
    const ids = Array.from(selected);
    try {
      await Promise.all(ids.map((id) => removeAlbumItem(albumId, id)));
      const message = `Removed ${ids.length} item${ids.length !== 1 ? 's' : ''} from album`;
      setSnackbar({ message, severity: 'success' });
      setSelected(new Set());
      setSelectionMode(false);
      setLocalPatches({});
      if (isFeedMode) {
        feedReset();
      }
      onChange?.();
    } catch (err) {
      setSnackbar({
        message: err instanceof Error ? err.message : 'Failed to remove items from album',
        severity: 'error',
      });
    }
  }, [albumId, selected, isFeedMode, feedReset, onChange]);

  // -------------------------------------------------------------------------
  // AddToAlbum filters — strip pagination/sort from queryParams;
  // in album mode also strip albumId so items can be added to a different album.
  // -------------------------------------------------------------------------

  const albumDialogFilters = useMemo<MediaQueryParams>(() => {
    if (!queryParams) {
      // Controlled mode — fall back to bare circleId filter
      return { circleId };
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { page: _p, pageSize: _ps, sortBy: _sb, sortOrder: _so, ...rest } = queryParams;
    if (albumId) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { albumId: _aid, ...restWithoutAlbum } = rest;
      return restWithoutAlbum;
    }
    return rest;
  }, [queryParams, albumId, circleId]);

  // -------------------------------------------------------------------------
  // Derived display flags
  // -------------------------------------------------------------------------

  const showFirstLoad = isFeedMode && isLoading && baseItems.length === 0;
  const showEmpty = !isLoading && !error && mergedItems.length === 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Box sx={{ minHeight: 0 }}>
      {/* Error */}
      {error && (
        <Box sx={{ p: { xs: 2, md: 3 } }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      )}

      {/* First-page loading skeletons (feed mode) */}
      {showFirstLoad && (
        <Box sx={{ p: { xs: 1, sm: 2 } }}>
          <Skeleton variant="text" width={180} height={24} sx={{ mb: 1 }} />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'repeat(3, 1fr)',
                sm: 'repeat(4, 1fr)',
                md: 'repeat(6, 1fr)',
              },
              gap: '2px',
            }}
          >
            {Array.from({ length: 18 }).map((_, i) => (
              <Skeleton
                key={i}
                variant="rectangular"
                sx={{ aspectRatio: '1', borderRadius: 0.5 }}
              />
            ))}
          </Box>
        </Box>
      )}

      {/* Controlled-mode loading spinner */}
      {!isFeedMode && isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Empty state */}
      {showEmpty && (
        <Box>
          {emptyState ?? (
            <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
              <PhotoLibraryIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
              <Typography variant="h6" color="text.secondary">
                No media found
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {/* Day-grouped grid */}
      {!showFirstLoad && mergedItems.length > 0 && (
        <Box sx={{ px: { xs: 1, sm: 2 }, pt: { xs: 1, sm: 2 } }}>
          {grouped.map((group) => (
            <Box key={group.key} sx={{ mb: 3 }}>
              {/* Sticky day header with per-group Select all / Clear */}
              <Box
                sx={{
                  position: 'sticky',
                  top: APP_BAR_HEIGHT,
                  zIndex: 10,
                  py: 0.75,
                  px: 0.5,
                  mb: 0.5,
                  backgroundColor: theme.palette.background.default,
                  borderBottom: `1px solid ${theme.palette.divider}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {group.label}
                </Typography>

                <Stack direction="row" spacing={0.5}>
                  <Button
                    size="small"
                    variant="text"
                    sx={{ minWidth: 'auto', fontSize: '0.7rem', py: 0 }}
                    onClick={() => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        group.items.forEach((item) => next.add(item.id));
                        return next;
                      });
                    }}
                  >
                    Select all
                  </Button>
                  {group.items.some((item) => selected.has(item.id)) && (
                    <Button
                      size="small"
                      variant="text"
                      sx={{ minWidth: 'auto', fontSize: '0.7rem', py: 0 }}
                      onClick={() => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          group.items.forEach((item) => next.delete(item.id));
                          return next;
                        });
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </Stack>
              </Box>

              {/* Responsive 3/4/6-col square thumbnail grid */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: 'repeat(3, 1fr)',
                    sm: 'repeat(4, 1fr)',
                    md: 'repeat(6, 1fr)',
                  },
                  gap: '2px',
                }}
              >
                {group.items.map((item) => {
                  const globalIndex = mergedItems.indexOf(item);
                  return (
                    <GalleryTile
                      key={item.id}
                      item={item}
                      onSelect={() => setLightboxIndex(globalIndex !== -1 ? globalIndex : 0)}
                      onToggleFavorite={handleToggleFavorite}
                      isSelected={selected.has(item.id)}
                      anySelected={selected.size > 0}
                      onToggleSelect={handleToggleSelect}
                      selectionMode={selectionMode}
                    />
                  );
                })}
              </Box>
            </Box>
          ))}

          {/* Infinite scroll sentinel (feed mode only) */}
          {isFeedMode && <Box ref={sentinelRef} sx={{ height: 1 }} />}

          {/* Bottom loading spinner (feed mode, fetching next page) */}
          {isFeedMode && isLoading && baseItems.length > 0 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          )}

          {/* End-of-list hint (feed mode) */}
          {isFeedMode && !feedHasMore && !isLoading && baseItems.length > 0 && (
            <Box sx={{ textAlign: 'center', py: 3 }}>
              <Typography variant="caption" color="text.disabled">
                All memories loaded
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {/* Lightbox */}
      <MediaLightbox
        items={mergedItems}
        index={lightboxIndex}
        onIndexChange={(i) => {
          setLightboxIndex(i);
          setDrawerOpen(false);
        }}
        onClose={() => setLightboxIndex(null)}
        onOpenProperties={(item) => {
          setDetailItem(item);
          setDrawerOpen(true);
        }}
        onItemUpdated={handleItemUpdated}
      />

      {/* Detail drawer */}
      <MediaDetailDrawer
        item={detailItem}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onItemUpdated={handleItemUpdated}
      />

      {/* Bulk action toolbar */}
      <BulkActionToolbar
        selected={selected}
        circleId={circleId}
        activeCircleRole={activeCircleRole}
        onClear={handleClearSelection}
        onOpenLocation={() => setBulkLocationOpen(true)}
        onOpenTags={() => setBulkTagsOpen(true)}
        onOpenAlbum={() => setAddToAlbumOpen(true)}
        albumMode={Boolean(albumId)}
        onRemoveFromAlbum={albumId ? () => void handleRemoveFromAlbum() : undefined}
        onSuccess={handleBulkSuccess}
        onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
      />

      {/* Bulk location dialog */}
      <BulkLocationDialog
        open={bulkLocationOpen}
        onClose={() => setBulkLocationOpen(false)}
        circleId={circleId}
        ids={Array.from(selected)}
        onSuccess={(msg) => {
          setBulkLocationOpen(false);
          handleBulkSuccess(msg);
        }}
      />

      {/* Bulk tags dialog */}
      <BulkTagsDialog
        open={bulkTagsOpen}
        onClose={() => setBulkTagsOpen(false)}
        circleId={circleId}
        ids={Array.from(selected)}
        onSuccess={(msg) => {
          setBulkTagsOpen(false);
          handleBulkSuccess(msg);
        }}
      />

      {/* Add to album dialog */}
      <AddToAlbumDialog
        open={addToAlbumOpen}
        onClose={() => setAddToAlbumOpen(false)}
        circleId={circleId}
        selectedIds={Array.from(selected)}
        filters={albumDialogFilters}
        matchingCount={mergedItems.length}
        onSuccess={(msg) => {
          setAddToAlbumOpen(false);
          handleBulkSuccess(msg);
        }}
        onError={(msg) => {
          setAddToAlbumOpen(false);
          setSnackbar({ message: msg, severity: 'error' });
        }}
      />

      {/* Snackbar for bulk operation feedback */}
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar(null)}
          severity={snackbar?.severity ?? 'success'}
          sx={{ width: '100%' }}
        >
          {snackbar?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
