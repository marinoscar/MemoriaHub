/**
 * MediaGallery — canonical day-grouped infinite grid with multi-select,
 * lightbox, properties drawer, and bulk actions.
 *
 * Tiles carry a static favorite badge only; favoriting is done through
 * selection + BulkActionToolbar (or the lightbox), never from the tile itself.
 *
 * Two data-source modes:
 *   FEED mode   (queryParams provided): calls useInfiniteMedia internally and
 *               renders an infinite-scroll sentinel.
 *   CONTROLLED  (items provided): renders the supplied array, no fetching;
 *               uses isLoading for a spinner; calls onChange on bulk success.
 *
 * Album mode is activated by passing albumId.  It adds "Remove from Album"
 * to the BulkActionToolbar and wires onRemoveFromAlbum accordingly.
 *
 * BULK SUCCESS AND THE LOADED FEED (issue #242)
 * ---------------------------------------------
 * `handleBulkSuccess` used to `feedReset()` after EVERY bulk action. A reset
 * bumps useInfiniteMedia's generation counter, empties the item list and
 * refetches page 1 — so a user who had scrolled through ten pages to edit one
 * photo's date lost all ten and was clamped back to the top of the document.
 *
 * Bulk actions are therefore classified by their effect on the CURRENT view:
 *
 *   'metadata'   — the item stays in the feed (location, date taken, tags,
 *                  favorite, add to album, thumbnail/face/tag reruns, and the
 *                  AI-enhance *replace* decision, which keeps the same item id
 *                  and only swaps its bytes). The affected ids are refetched
 *                  with `getMedia` and merged into `localPatches`, exactly the
 *                  targeted in-place merge the single-item drawer already used
 *                  via `handleItemUpdated`. No reset, no scroll jump.
 *
 *   'membership' — the item leaves the current view (archive, unarchive,
 *                  trash, restore, delete forever, remove from album). The ids
 *                  are added to `removedIds` and filtered out of the rendered
 *                  list in place. Still no reset. An action that only partly
 *                  succeeded reports the ids it left behind as
 *                  `options.retainedIds` (Trash restore returns `conflicts[]`
 *                  for items whose content hash collides with an active item —
 *                  those are NOT restored and must stay on screen).
 *
 * `feedReset()` now survives ONLY for genuine feed changes: a query/circle
 * change (handled inside useInfiniteMedia via its queryKey) and the upload
 * `triggerRefresh` path.
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
  CircularProgress,
  Stack,
  Snackbar,
  Alert,
  useMediaQuery,
} from '@mui/material';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import BrokenImageIcon from '@mui/icons-material/BrokenImage';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import StarIcon from '@mui/icons-material/Star';
import BurstModeIcon from '@mui/icons-material/BurstMode';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useTheme } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import { useInfiniteMedia } from '../../hooks/useInfiniteMedia';
import type { InfiniteMediaFetcher } from '../../hooks/useInfiniteMedia';
import { useIntersectionObserver } from '../../hooks/useIntersectionObserver';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMediaRefresh } from '../../contexts/MediaRefreshContext';
import { useMediaPreview } from '../../contexts/MediaPreviewContext';
import { usePendingThumbnails } from '../../hooks/usePendingThumbnails';
import { groupByDay } from '../../utils/groupByDay';
import { isThumbnailStuck } from '../../utils/thumbnailTimeout';
import { MediaDetailDrawer } from './MediaDetailDrawer';
import { MediaSelectionCheckbox } from './MediaSelectionCheckbox';
import { MediaLightbox } from './MediaLightbox';
import { MediaEnhancementDrawer } from './MediaEnhancementDrawer';
import { BatchEnhanceDialog } from './BatchEnhanceDialog';
import { BulkActionToolbar } from './BulkActionToolbar';
import type { BulkEffect, BulkSuccessOptions } from './BulkActionToolbar';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { TrashBulkToolbar } from './TrashBulkToolbar';
import { ArchiveBulkToolbar } from './ArchiveBulkToolbar';
import { BulkLocationDialog } from './BulkLocationDialog';
import { BulkDateDialog } from './BulkDateDialog';
import { BulkTagsDialog } from './BulkTagsDialog';
import { AddToAlbumDialog } from '../album/AddToAlbumDialog';
import { TimelineScrubber } from './TimelineScrubber';
import { getMedia, removeAlbumItem } from '../../services/media';
import type { MediaItem, MediaQueryParams } from '../../types/media';
import type { CircleRole } from '../../types/circles';

// ---------------------------------------------------------------------------
// Grid geometry — ONE source of truth for the column count
// ---------------------------------------------------------------------------

/**
 * Column count per breakpoint. Consumed by BOTH `gridTemplateColumns` and the
 * `content-visibility` placeholder math below — they must never drift. Issue
 * #237: the placeholder used to hard-code the desktop `/ 6`, so on a phone
 * (3 columns) every group reserved half the height it actually needed and the
 * document grew by roughly a group's height each time one scrolled into view.
 */
export const GALLERY_COLS = { xs: 3, sm: 4, md: 6 } as const;

/** Inter-tile grid gap, in px. Must match the grid's `gap` value. */
export const GALLERY_GAP_PX = 2;

/**
 * Row height assumed before the first ResizeObserver measurement lands. Tiles
 * are `aspectRatio: '1'`, so the real row height is derived from the measured
 * container width instead — this is only the pre-measurement estimate.
 */
export const GALLERY_FALLBACK_ROW_PX = 120;

const GALLERY_GRID_COLUMNS = {
  xs: `repeat(${GALLERY_COLS.xs}, 1fr)`,
  sm: `repeat(${GALLERY_COLS.sm}, 1fr)`,
  md: `repeat(${GALLERY_COLS.md}, 1fr)`,
} as const;

/**
 * Height reserved by `contain-intrinsic-size` for an off-screen day group.
 *
 * @param itemCount items in the group
 * @param cols      columns at the ACTIVE breakpoint (never a hard-coded 6)
 * @param tileSize  measured square tile edge in px, or null before the first
 *                  ResizeObserver callback (falls back to the old estimate)
 */
export function galleryPlaceholderHeight(
  itemCount: number,
  cols: number,
  tileSize: number | null,
): number {
  const rows = Math.ceil(itemCount / cols);
  const rowHeight =
    tileSize !== null && tileSize > 0 ? tileSize + GALLERY_GAP_PX : GALLERY_FALLBACK_ROW_PX;
  return Math.round(rows * rowHeight);
}

/**
 * Sticky day-header offset. MUI's Toolbar is 56px below the `sm` breakpoint and
 * 64px at `sm` and up — a flat 64 left an 8px see-through gap under the AppBar
 * on phones (issue #237).
 */
const DAY_HEADER_TOP = { xs: 56, sm: 64 } as const;

/**
 * How many `getMedia` refetches are issued concurrently after a metadata bulk
 * action (issue #242). A bulk action accepts up to 500 ids; firing 500 parallel
 * requests would be worse than the reset it replaces, so the ids are walked in
 * chunks of this size, one chunk at a time.
 */
export const BULK_REFRESH_CHUNK_SIZE = 25;

// ---------------------------------------------------------------------------
// GalleryTile — internal thumbnail tile
// ---------------------------------------------------------------------------

interface GalleryTileProps {
  item: MediaItem;
  onSelect: (item: MediaItem) => void;
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
  isSelected,
  anySelected,
  onToggleSelect,
  selectionMode,
  showOriginBadge,
}: GalleryTileProps) {
  const theme = useTheme();
  const isMobileDevice = useMediaQuery(theme.breakpoints.down('sm'));
  // Any pointer without hover (phones, tablets) never fires :hover, so
  // hover-revealed controls must be shown outright there instead.
  const isTouchDevice = useMediaQuery('(hover: none)');
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

  // The selection checkbox is hover-revealed on pointers that have hover, and
  // permanently visible everywhere else — a hover-only reveal would otherwise
  // leave an invisible tap target on touch devices.
  const checkboxAlwaysVisible =
    isMobileDevice || isTouchDevice || selectionMode || anySelected || isSelected;

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
          opacity: checkboxAlwaysVisible ? 1 : 0,
          transition: 'opacity 0.15s',
          // Reveal on hover only where hover genuinely exists (issue #243) —
          // a bare :hover rule would leave this invisible yet tappable on any
          // hover-less pointer; those get the always-visible branch above.
          '@media (hover: hover)': {
            '.MuiImageListItem-root:hover &': { opacity: 1 },
          },
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

      {/* Favorite badge — static status indicator, NOT a control (issue #243).
          A hover-revealed toggle here was invisible yet fully tappable on touch
          devices, silently starring photos. Favoriting is done from selection +
          BulkActionToolbar, or from the lightbox. */}
      {item.favorite && (
        <Box
          role="img"
          aria-label="Favorite"
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 2,
            display: 'flex',
            pointerEvents: 'none',
            color: 'warning.main',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
          }}
        >
          <StarIcon fontSize="small" />
        </Box>
      )}

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
  // `feedIsLoading` is deliberately NOT part of `disabled`: flipping it tears
  // the observer down and re-creates it, and `observe()` always delivers an
  // initial callback — so a sentinel still inside the root margin re-fires
  // immediately, chain-loading page after page (issue #291). Concurrency is
  // already guarded by `useInfiniteMedia`'s `inflightRef`; the sentinel must
  // now genuinely leave and re-enter the root margin to load again.
  useIntersectionObserver(sentinelRef, feedLoadMore, {
    rootMargin: '300px',
    disabled: !isFeedMode || !feedHasMore || !circleId,
  });

  // -------------------------------------------------------------------------
  // Locally-removed ids (membership bulk actions — issue #242)
  //
  // Archive/trash/restore/… remove an item from THIS view but must not throw
  // away the pages already loaded. The ids are filtered out of the rendered
  // list instead, and the set is cleared whenever the feed genuinely resets.
  // -------------------------------------------------------------------------

  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  const markRemoved = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setRemovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  // Mirror of the key useInfiniteMedia resets on, so a query/circle change
  // drops the stale removal set along with the stale items.
  const feedResetKey = queryKey ?? JSON.stringify(queryParams ?? {});
  useEffect(() => {
    // Identity-stable when already empty, so the mount-time run is a no-op
    // rather than an extra render.
    setRemovedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [feedResetKey]);

  // Feed-mode refresh: reset to page 1 whenever a new upload completes.
  // The context has a safe default (refreshToken:0, triggerRefresh:noop) so
  // this is harmless when no MediaRefreshProvider is mounted.
  const { refreshToken } = useMediaRefresh();
  const refreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    // Skip the initial mount — only react to increments.
    if (refreshToken === refreshTokenRef.current) return;
    refreshTokenRef.current = refreshToken;
    setRemovedIds((prev) => (prev.size === 0 ? prev : new Set()));
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
  // Optimistic patches (thumbnail reconcile, lightbox/drawer item updates)
  // -------------------------------------------------------------------------

  const [localPatches, setLocalPatches] = useState<Record<string, Partial<MediaItem>>>({});

  const mergedItems = useMemo(
    () =>
      baseItems
        .filter((item) => !removedIds.has(item.id))
        .map((item) =>
          localPatches[item.id] ? { ...item, ...localPatches[item.id] } : item,
        ),
    [baseItems, localPatches, removedIds],
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

  const { pictureEnhancement } = useFeatureFlags();
  const enhanceEnabled = Boolean(pictureEnhancement?.enabled);
  const [enhanceOpen, setEnhanceOpen] = useState(false);

  const [batchEnhanceOpen, setBatchEnhanceOpen] = useState(false);

  const singleSelectedItem = useMemo<MediaItem | null>(() => {
    if (selected.size !== 1) return null;
    const [onlyId] = Array.from(selected);
    return mergedItems.find((it) => it.id === onlyId) ?? null;
  }, [selected, mergedItems]);

  /** The selected items, resolved against the current feed. */
  const selectedItems = useMemo(
    () => mergedItems.filter((it) => selected.has(it.id)),
    [selected, mergedItems],
  );

  /**
   * Photos in the selection. AI Enhance is photo-only, so a mixed selection of
   * one photo and one video is still a single-photo enhance — the per-item
   * drawer, with its live compare and immediate decision, is a better
   * experience than a batch of one.
   */
  const selectedPhotos = useMemo(
    () => selectedItems.filter((it) => it.type === 'photo'),
    [selectedItems],
  );

  /** The item the single-photo enhance drawer acts on, if exactly one. */
  const enhanceTargetItem = selectedPhotos.length === 1 ? selectedPhotos[0] : null;

  // -------------------------------------------------------------------------
  // Bulk success handler
  // -------------------------------------------------------------------------

  const isMounted = useIsMounted();

  /**
   * Refetch the given items and merge them into `localPatches` — the same
   * targeted in-place merge `handleItemUpdated` performs for the drawer, just
   * for many ids at once. Requests are issued `BULK_REFRESH_CHUNK_SIZE` at a
   * time; a single failed id is dropped so the rest of the merge still lands.
   */
  const refreshItemsById = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const patches: Record<string, Partial<MediaItem>> = {};
      for (let i = 0; i < ids.length; i += BULK_REFRESH_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + BULK_REFRESH_CHUNK_SIZE);
        const results = await Promise.all(
          chunk.map((id) => getMedia(id).catch(() => null)),
        );
        for (const item of results) {
          if (item) patches[item.id] = item;
        }
        if (!isMounted()) return;
      }
      if (!isMounted()) return;
      if (Object.keys(patches).length === 0) return;
      setLocalPatches((prev) => ({ ...prev, ...patches }));
    },
    [isMounted],
  );

  /**
   * Shared completion handler for every bulk action. `effect` decides whether
   * the affected items are refetched in place ('metadata', the default) or
   * filtered out of the current view ('membership') — see the file header for
   * why neither path may reset the feed (issue #242).
   *
   * A membership action may report `options.retainedIds` for selected items the
   * server left behind (Trash restore conflicts); those keep their place in the
   * list so it agrees with the message the user is being shown.
   */
  const handleBulkSuccess = useCallback(
    (message: string, effect: BulkEffect = 'metadata', options?: BulkSuccessOptions) => {
      // Capture BEFORE clearing the selection — the ids are the payload.
      const ids = Array.from(selected);
      setSnackbar({ message, severity: 'success' });
      setSelected(new Set());
      setSelectionMode(false);
      if (effect === 'membership') {
        const retained = new Set(options?.retainedIds ?? []);
        markRemoved(ids.filter((id) => !retained.has(id)));
      } else {
        void refreshItemsById(ids);
      }
      if (!isFeedMode) {
        // Controlled mode owns its item array, so the parent has to refetch.
        // Feed mode deliberately does NOT call onChange — some callers wire it
        // to state changes (e.g. SearchPage's clearSearch) that assume the
        // controlled-mode contract.
        onChange?.();
      }
      onBulkSuccess?.(message);
    },
    [selected, markRemoved, refreshItemsById, isFeedMode, onChange, onBulkSuccess],
  );

  /**
   * Convenience wrapper for toolbars whose every action is membership-changing.
   * `options` is forwarded so a partial outcome (e.g. Trash restore conflicts)
   * can keep the items it left behind on screen.
   */
  const handleMembershipSuccess = useCallback(
    (message: string, options?: BulkSuccessOptions) =>
      handleBulkSuccess(message, 'membership', options),
    [handleBulkSuccess],
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
      // Membership-changing: the items leave this album's view but the rest of
      // the loaded feed stays exactly where it is (issue #242).
      markRemoved(ids);
      // Unlike handleBulkSuccess, onChange fires in both modes here — album
      // pages rely on it to refresh the header item count.
      onChange?.();
    } catch (err) {
      setSnackbar({
        message: err instanceof Error ? err.message : 'Failed to remove items from album',
        severity: 'error',
      });
    }
  }, [albumId, selected, markRemoved, onChange]);

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
  // Grid measurement — ONE ResizeObserver for the whole gallery (never one per
  // day group). Feeds the content-visibility placeholder math so an off-screen
  // group reserves the height it will actually occupy at the current width.
  // -------------------------------------------------------------------------

  const isSmUp = useMediaQuery(theme.breakpoints.up('sm'));
  const isMdUp = useMediaQuery(theme.breakpoints.up('md'));
  const cols = isMdUp ? GALLERY_COLS.md : isSmUp ? GALLERY_COLS.sm : GALLERY_COLS.xs;

  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const gridObserverRef = useRef<ResizeObserver | null>(null);

  // Callback ref: the grid wrapper mounts/unmounts with the item list, so a
  // mount-time useEffect would miss it. contentRect excludes the wrapper's own
  // horizontal padding, which is exactly the width the columns divide up.
  const gridRootRef = useCallback((el: HTMLDivElement | null) => {
    gridObserverRef.current?.disconnect();
    gridObserverRef.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      // Clamp to the layout viewport so the observer can never consume a width
      // its own output produced (issue #291). The placeholder derived from this
      // measurement is an intrinsic size the shell may honour; without the
      // clamp, measure -> placeholder -> wider shell -> measure is a positive
      // feedback loop that diverges whenever rows > cols.
      const viewport =
        typeof document !== 'undefined' ? document.documentElement.clientWidth : 0;
      const width = viewport > 0 ? Math.min(measured, viewport) : measured;
      setGridWidth(width > 0 ? width : null);
    });
    observer.observe(el);
    gridObserverRef.current = observer;
  }, []);

  useEffect(() => () => gridObserverRef.current?.disconnect(), []);

  const tileSize = useMemo(() => {
    if (gridWidth === null) return null;
    const size = (gridWidth - (cols - 1) * GALLERY_GAP_PX) / cols;
    return size > 0 ? size : null;
  }, [gridWidth, cols]);

  /**
   * Per-group `contain-intrinsic-height` strings, keyed by group key.
   *
   * Memoised because the value is interpolated into `sx`: computing it inline
   * would mint a fresh Emotion class for every day group on every
   * ResizeObserver tick (issue #291).
   */
  const groupPlaceholderHeights = useMemo(() => {
    const map = new Map<string, string>();
    grouped.forEach((group) => {
      map.set(
        group.key,
        `auto ${galleryPlaceholderHeight(group.items.length, cols, tileSize)}px`,
      );
    });
    return map;
  }, [grouped, cols, tileSize]);

  // -------------------------------------------------------------------------
  // Derived display flags
  // -------------------------------------------------------------------------

  const showFirstLoad = isFeedMode && isLoading && baseItems.length === 0;
  const showEmpty = !isLoading && !error && mergedItems.length === 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    // `minWidth: 0` so this subtree can always shrink below its content-based
    // minimum if an ancestor ever becomes a flex container. The `minHeight: 0`
    // it replaces was a no-op — the parent is not a flex container, and the
    // axis that needed constraining was the inline one (issue #291).
    <Box sx={{ minWidth: 0, minHeight: 0 }}>
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
              gridTemplateColumns: GALLERY_GRID_COLUMNS,
              gap: `${GALLERY_GAP_PX}px`,
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
          // Restore / delete-forever both take the item out of Trash's view —
          // except restore conflicts, reported back via options.retainedIds.
          onSuccess={handleMembershipSuccess}
          onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
        />
      ) : mode === 'archive' ? (
        <ArchiveBulkToolbar
          selected={selected}
          circleId={circleId}
          activeCircleRole={activeCircleRole}
          onClear={handleClearSelection}
          onSelectAll={handleSelectAll}
          // Unarchive / move-to-Trash both take the item out of Archive's view.
          onSuccess={handleMembershipSuccess}
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
          selectedItems={selectedItems}
          enhanceEnabled={enhanceEnabled}
          maxBatchSize={pictureEnhancement?.maxBatchSize}
          onOpenEnhance={() => setEnhanceOpen(true)}
          onOpenBatchEnhance={() => setBatchEnhanceOpen(true)}
        />
      )}

      {/* Day-grouped grid */}
      {!showFirstLoad && mergedItems.length > 0 && (
        <Box
          ref={gridRootRef}
          data-testid="gallery-root"
          sx={{ px: { xs: 1, sm: 2 }, pt: { xs: 1, sm: 2 } }}
        >
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
                  top: DAY_HEADER_TOP,
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
                data-testid="gallery-day-grid"
                sx={{
                  display: 'grid',
                  gridTemplateColumns: GALLERY_GRID_COLUMNS,
                  gap: `${GALLERY_GAP_PX}px`,
                  contentVisibility: 'auto',
                  // Longhands, never the `contain-intrinsic-size` shorthand: a
                  // single-value shorthand applies to BOTH axes, so a height
                  // placeholder of N px also claims an intrinsic WIDTH of N px
                  // for a never-painted group — which is what blew the mobile
                  // gallery up on pagination (issue #291).
                  containIntrinsicWidth: 'none',
                  containIntrinsicHeight: groupPlaceholderHeights.get(group.key),
                }}
              >
                {group.items.map((item) => (
                  <GalleryTile
                    key={item.id}
                    item={item}
                    onSelect={handleSelectTile}
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
      {enhanceTargetItem && (
        <MediaEnhancementDrawer
          item={enhanceTargetItem}
          open={enhanceOpen}
          onClose={() => setEnhanceOpen(false)}
          modelLabel={pictureEnhancement?.model ?? undefined}
          replacePolicy={
            pictureEnhancement
              ? {
                  allowReplace: pictureEnhancement.allowReplace,
                  blockReplaceOnDownscale: pictureEnhancement.blockReplaceOnDownscale,
                }
              : undefined
          }
          // Replace keeps the same item id and only swaps its bytes, so it is a
          // metadata refresh of the selected item — never a feed reset (#242).
          onReplaced={() => {
            setEnhanceOpen(false);
            handleBulkSuccess('Photo replaced with the enhanced version');
          }}
          // Keep-both leaves the source item untouched and creates a second
          // one; the source is refreshed in place and the new item appears on
          // the next natural feed load rather than costing the user their
          // scroll position.
          onKeptBoth={(msg) => {
            setEnhanceOpen(false);
            handleBulkSuccess(msg);
          }}
          // Fired when the job finishes while the panel is closed. Uses the
          // snackbar directly rather than handleBulkSuccess, which clears the
          // selection — that would unmount the drawer and lose the review.
          onFinishedInBackground={(s) =>
            setSnackbar(
              s === 'ready'
                ? {
                    message: 'Your enhanced photo is ready — reopen AI Enhance to review it',
                    severity: 'success',
                  }
                : { message: 'The AI enhancement failed. Open AI Enhance for details.', severity: 'error' },
            )
          }
        />
      )}

      {/* AI enhancement dialog (multi-photo batch) */}
      <BatchEnhanceDialog
        open={batchEnhanceOpen}
        onClose={() => setBatchEnhanceOpen(false)}
        target={{
          kind: 'selection',
          circleId,
          photoIds: selectedPhotos.map((it) => it.id),
          nonPhotoCount: selectedItems.length - selectedPhotos.length,
        }}
        maxBatchSize={pictureEnhancement?.maxBatchSize ?? 25}
        modelLabel={pictureEnhancement?.model ?? undefined}
        // Queueing changes nothing about the items yet, so this is the ordinary
        // metadata path: toast + clear the selection, never a feed reset.
        onSuccess={(msg) => {
          setBatchEnhanceOpen(false);
          handleBulkSuccess(msg);
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
