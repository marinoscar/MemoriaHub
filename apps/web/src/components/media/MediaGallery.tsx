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

import { useState, useRef, useMemo, useCallback, useEffect, memo } from 'react';
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
  BrokenImage as BrokenImageIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  BurstMode as BurstModeIcon,
  ContentCopy as ContentCopyIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import { useInfiniteMedia } from '../../hooks/useInfiniteMedia';
import type { InfiniteMediaFetcher } from '../../hooks/useInfiniteMedia';
import { useIntersectionObserver } from '../../hooks/useIntersectionObserver';
import { useMediaRefresh } from '../../contexts/MediaRefreshContext';
import { useMediaPreview } from '../../contexts/MediaPreviewContext';
import { usePendingThumbnails } from '../../hooks/usePendingThumbnails';
import { groupByDay } from '../../utils/groupByDay';
import { isThumbnailStuck } from '../../utils/thumbnailTimeout';
import { MediaDetailDrawer } from './MediaDetailDrawer';
import { MediaSelectionCheckbox } from './MediaSelectionCheckbox';
import { MediaLightbox } from './MediaLightbox';
import { MediaEnhancementDrawer } from './MediaEnhancementDrawer';
import { BulkActionToolbar } from './BulkActionToolbar';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { TrashBulkToolbar } from './TrashBulkToolbar';
import { ArchiveBulkToolbar } from './ArchiveBulkToolbar';
import { BulkLocationDialog } from './BulkLocationDialog';
import { BulkDateDialog } from './BulkDateDialog';
import { BulkTagsDialog } from './BulkTagsDialog';
import { AddToAlbumDialog } from '../album/AddToAlbumDialog';
import { TimelineScrubber } from './TimelineScrubber';
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
  onSelect: (item: MediaItem) => void;
  onToggleFavorite: (item: MediaItem) => void;
  isSelected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string) => void;
  selectionMode: boolean;
  /**
   * Show the burst/duplicate "origin" badge — only meaningful on the
   * Archive/Trash surfaces, where a resolved review group's non-kept
   * members still carry a stale burstGroupId/duplicateGroupId. Active-item
   * surfaces (home/album/search) never render this; a "kept" survivor can
   * carry a stale id there too and the badge would just be noise.
   */
  showOriginBadge: boolean;
}

const GalleryTile = memo(function GalleryTile({
  item,
  onSelect,
  onToggleFavorite,
  isSelected,
  anySelected,
  onToggleSelect,
  selectionMode,
  showOriginBadge,
}: GalleryTileProps) {
  const theme = useTheme();
  const isMobileDevice = useMediaQuery(theme.breakpoints.down('sm'));
  const [imgError, setImgError] = useState(false);
  const { getPreview } = useMediaPreview();
  const navigate = useNavigate();

  // Burst takes precedence over duplicate when (defensively) both are set —
  // never render two origin badges on one tile.
  const originType: 'burst' | 'duplicate' | null = item.burstGroupId
    ? 'burst'
    : item.duplicateGroupId
      ? 'duplicate'
      : null;
  const showBadge = showOriginBadge && originType !== null;

  // Instant local upload preview (object URL) shown while the server thumbnail
  // is still being generated. Only consulted when there is no server thumbnail
  // yet and the image hasn't errored.
  const preview =
    !item.thumbnailUrl && !imgError ? getPreview(item.id) : undefined;

  return (
    <ImageListItem
      onClick={() => {
        if (selectionMode || anySelected) {
          onToggleSelect(item.id);
        } else {
          onSelect(item);
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
            alt={item.originalFilename}
            loading="lazy"
            decoding="async"
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
      ) : preview ? (
        /* Instant local upload preview (object URL) while the server
           thumbnail is generated; swapped out by the reconcile hook. */
        <Box
          component="img"
          src={preview}
          alt={item.originalFilename}
          decoding="async"
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (item.type === 'photo' || item.type === 'video') && !imgError && !isThumbnailStuck(item.createdAt) ? (
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
      ) : (item.type === 'photo' || item.type === 'video') && !imgError ? (
        /* Thumbnail never arrived within the recovery window — stop spinning forever */
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BrokenImageIcon sx={{ fontSize: 36, color: theme.palette.grey[600] }} aria-label="Thumbnail unavailable" />
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
        <MediaSelectionCheckbox
          checked={isSelected}
          onToggle={() => onToggleSelect(item.id)}
          ariaLabel={isSelected ? 'Deselect item' : 'Select item'}
        />
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

      {/* Origin badge — Archive/Trash only; links to the resolved burst or
          duplicate review group this item's non-kept copy came from. */}
      {showBadge && (
        <Tooltip title={originType === 'burst' ? 'View burst group' : 'View duplicate group'}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              navigate(
                originType === 'burst'
                  ? `/bursts/${item.burstGroupId}`
                  : `/duplicates/${item.duplicateGroupId}`,
              );
            }}
            aria-label={originType === 'burst' ? 'View burst group' : 'View duplicate group'}
            sx={{
              position: 'absolute',
              bottom: 4,
              left: 4,
              zIndex: 2,
              backgroundColor: 'rgba(0,0,0,0.55)',
              color: 'white',
              p: { xs: 1, sm: 0.5 },
              '&:hover': { backgroundColor: 'rgba(0,0,0,0.75)' },
            }}
          >
            {originType === 'burst' ? (
              <BurstModeIcon fontSize="small" />
            ) : (
              <ContentCopyIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      )}
    </ImageListItem>
  );
});

// ---------------------------------------------------------------------------
// MediaGalleryProps
// ---------------------------------------------------------------------------

export interface MediaGalleryProps {
  circleId: string;
  activeCircleRole: CircleRole | null;

  /** FEED mode: component calls useInfiniteMedia with these params. */
  queryParams?: MediaQueryParams;
  /**
   * FEED mode (pluggable): custom page fetcher passed straight to
   * useInfiniteMedia. When supplied, the gallery fetches through this instead
   * of the default `listMedia` — letting any paginated media surface (Trash,
   * Archive, …) reuse the gallery. Providing `fetcher` alone activates FEED
   * mode even without `queryParams`.
   */
  fetcher?: InfiniteMediaFetcher;
  /**
   * Reset/refetch key for the custom fetcher. Changing it resets the feed to
   * page 1. Defaults to JSON.stringify(queryParams) inside the hook.
   */
  queryKey?: string;
  /**
   * Which bulk toolbar to render in the toolbar slot (always ABOVE the grid):
   *   'home'    → BulkActionToolbar (location/date/tags/album/…)
   *   'trash'   → TrashBulkToolbar (restore / delete forever)
   *   'archive' → ArchiveBulkToolbar (unarchive / move to Trash)
   */
  mode?: 'home' | 'trash' | 'archive';
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
  /**
   * Optional passthrough invoked after any successful bulk action (any mode),
   * with the success message. Lets pages refresh their own external state
   * (e.g. Trash/Archive item counts) on top of the gallery's internal reset.
   */
  onBulkSuccess?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// MediaGallery
// ---------------------------------------------------------------------------

export function MediaGallery({
  circleId,
  activeCircleRole,
  queryParams,
  fetcher,
  queryKey,
  mode = 'home',
  items: controlledItems,
  isLoading: controlledLoading,
  pageSize = 50,
  albumId,
  emptyState,
  onChange,
  onBulkSuccess,
}: MediaGalleryProps) {
  const theme = useTheme();

  // Determine mode: FEED activates when EITHER queryParams OR a custom fetcher
  // is supplied. CONTROLLED mode is used only when neither is present.
  const isFeedMode = queryParams !== undefined || fetcher !== undefined;

  // -------------------------------------------------------------------------
  // FEED mode — infinite scroll via useInfiniteMedia
  // -------------------------------------------------------------------------

  const feedResult = useInfiniteMedia(
    // Always call the hook (rules of hooks); pass empty params in controlled mode
    isFeedMode ? (queryParams ?? {}) : {},
    pageSize,
    isFeedMode && !!circleId,
    { fetcher, queryKey },
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

  // Feed-mode refresh: reset to page 1 whenever a new upload completes.
  // The context has a safe default (refreshToken:0, triggerRefresh:noop) so
  // this is harmless when no MediaRefreshProvider is mounted.
  const { refreshToken } = useMediaRefresh();
  const refreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    // Skip the initial mount — only react to increments.
    if (refreshToken === refreshTokenRef.current) return;
    refreshTokenRef.current = refreshToken;
    if (isFeedMode) {
      feedReset();
    }
  }, [refreshToken, isFeedMode, feedReset]);

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

  // -------------------------------------------------------------------------
  // Pending-thumbnail reconcile: poll for the optimized server thumbnail of
  // freshly-uploaded items (shown via an instant local preview) and, once
  // ready, patch the tile and free the local blob.
  // -------------------------------------------------------------------------

  const { removePreview } = useMediaPreview();

  const applyThumbnails = useCallback(
    (updates: Array<{ id: string; thumbnailUrl: string }>) => {
      setLocalPatches((prev) => {
        const next = { ...prev };
        for (const { id, thumbnailUrl } of updates) {
          next[id] = { ...next[id], thumbnailUrl };
        }
        return next;
      });
      for (const { id } of updates) {
        removePreview(id);
      }
    },
    [removePreview],
  );

  usePendingThumbnails(mergedItems, circleId, applyThumbnails);

  const grouped = useMemo(() => groupByDay(mergedItems), [mergedItems]);

  // Registry of day-group DOM nodes keyed by group.key, for the TimelineScrubber
  // to resolve scroll targets. Falls back to id lookup if the map entry is stale.
  const groupElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const getGroupElement = useCallback(
    (key: string): HTMLElement | null =>
      groupElsRef.current.get(key) ?? document.getElementById(`group-${key}`),
    [],
  );

  // O(1) id→index map so each tile doesn't do an O(n) indexOf scan
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    mergedItems.forEach((it, i) => m.set(it.id, i));
    return m;
  }, [mergedItems]);

  // -------------------------------------------------------------------------
  // Lightbox + detail drawer
  // -------------------------------------------------------------------------

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleItemUpdated = useCallback((updated: MediaItem) => {
    setLocalPatches((prev) => ({ ...prev, [updated.id]: updated }));
  }, []);

  // Stable tile-select handler — avoids fresh closures per tile on each render
  const handleSelectTile = useCallback(
    (item: MediaItem) => {
      setLightboxIndex(indexById.get(item.id) ?? 0);
    },
    [indexById],
  );

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

  const handleSelectAll = useCallback(() => {
    setSelected(new Set(mergedItems.map((it) => it.id)));
  }, [mergedItems]);

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
  const [bulkDateOpen, setBulkDateOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);

  // -------------------------------------------------------------------------
  // AI Picture Enhancer — trigger from the single-select bar (photo only)
  // -------------------------------------------------------------------------

  const { settings } = useSystemSettings();
  const enhanceEnabled = Boolean(settings?.features?.pictureEnhancement);
  const [enhanceOpen, setEnhanceOpen] = useState(false);

  const singleSelectedItem = useMemo<MediaItem | null>(() => {
    if (selected.size !== 1) return null;
    const [onlyId] = Array.from(selected);
    return mergedItems.find((it) => it.id === onlyId) ?? null;
  }, [selected, mergedItems]);

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
      onBulkSuccess?.(message);
    },
    [isFeedMode, feedReset, onChange, onBulkSuccess],
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

      {/* Bulk action toolbar — one per mode, always rendered ABOVE the grid */}
      {mode === 'trash' ? (
        <TrashBulkToolbar
          selected={selected}
          circleId={circleId}
          activeCircleRole={activeCircleRole}
          onClear={handleClearSelection}
          onSelectAll={handleSelectAll}
          onSuccess={handleBulkSuccess}
          onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
        />
      ) : mode === 'archive' ? (
        <ArchiveBulkToolbar
          selected={selected}
          circleId={circleId}
          activeCircleRole={activeCircleRole}
          onClear={handleClearSelection}
          onSelectAll={handleSelectAll}
          onSuccess={handleBulkSuccess}
          onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
        />
      ) : (
        <BulkActionToolbar
          selected={selected}
          circleId={circleId}
          activeCircleRole={activeCircleRole}
          onClear={handleClearSelection}
          onSelectAll={handleSelectAll}
          onOpenLocation={() => setBulkLocationOpen(true)}
          onOpenDate={() => setBulkDateOpen(true)}
          onOpenTags={() => setBulkTagsOpen(true)}
          onOpenAlbum={() => setAddToAlbumOpen(true)}
          albumMode={Boolean(albumId)}
          onRemoveFromAlbum={albumId ? () => void handleRemoveFromAlbum() : undefined}
          onSuccess={handleBulkSuccess}
          onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
          singleSelectedItem={singleSelectedItem}
          enhanceEnabled={enhanceEnabled}
          onOpenEnhance={() => setEnhanceOpen(true)}
        />
      )}

      {/* Day-grouped grid */}
      {!showFirstLoad && mergedItems.length > 0 && (
        <Box sx={{ px: { xs: 1, sm: 2 }, pt: { xs: 1, sm: 2 } }}>
          {grouped.map((group) => (
            <Box
              key={group.key}
              id={`group-${group.key}`}
              ref={(el: HTMLElement | null) => {
                if (el) groupElsRef.current.set(group.key, el);
                else groupElsRef.current.delete(group.key);
              }}
              sx={{ mb: 3 }}
            >
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
                  contentVisibility: 'auto',
                  containIntrinsicSize: `auto ${Math.ceil(group.items.length / 6) * 120}px`,
                }}
              >
                {group.items.map((item) => (
                  <GalleryTile
                    key={item.id}
                    item={item}
                    onSelect={handleSelectTile}
                    onToggleFavorite={handleToggleFavorite}
                    isSelected={selected.has(item.id)}
                    anySelected={selected.size > 0}
                    onToggleSelect={handleToggleSelect}
                    selectionMode={selectionMode}
                    showOriginBadge={mode === 'archive' || mode === 'trash'}
                  />
                ))}
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
                All photos loaded
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {/* Timeline scrubber (self-hides when <2 month buckets). position:fixed,
          so its placement here does not affect layout. */}
      {!showFirstLoad && mergedItems.length > 0 && (
        <TimelineScrubber
          groups={grouped}
          getGroupElement={getGroupElement}
          onRequestLoadMore={isFeedMode ? feedLoadMore : undefined}
          hasMore={isFeedMode ? feedHasMore : false}
        />
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

      {/* Bulk date dialog */}
      <BulkDateDialog
        open={bulkDateOpen}
        onClose={() => setBulkDateOpen(false)}
        circleId={circleId}
        ids={Array.from(selected)}
        onSuccess={(msg) => {
          setBulkDateOpen(false);
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

      {/* AI enhancement drawer (single photo) */}
      {singleSelectedItem && singleSelectedItem.type === 'photo' && (
        <MediaEnhancementDrawer
          item={singleSelectedItem}
          open={enhanceOpen}
          onClose={() => setEnhanceOpen(false)}
          onReplaced={() => {
            setEnhanceOpen(false);
            handleBulkSuccess('Photo replaced with the enhanced version');
          }}
          onKeptBoth={(msg) => {
            setEnhanceOpen(false);
            handleBulkSuccess(msg);
          }}
        />
      )}

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
