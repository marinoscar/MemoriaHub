import { useState, useRef, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Alert,
  Skeleton,
  Button,
  Link,
  Fab,
  IconButton,
  Tooltip,
  ImageListItem,
  ImageListItemBar,
  CircularProgress,
  Stack,
  Snackbar,
  useMediaQuery,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  PhotoLibrary as PhotoLibraryIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  CheckBox as CheckBoxIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useTheme } from '@mui/material/styles';
import { useCircle } from '../hooks/useCircle';
import { useInfiniteMedia } from '../hooks/useInfiniteMedia';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { groupByDay } from '../utils/groupByDay';
import { MediaDetailDrawer } from '../components/media/MediaDetailDrawer';
import { MediaLightbox } from '../components/media/MediaLightbox';
import { MediaUploadDialog } from '../components/media/MediaUploadDialog';
import { BulkActionToolbar } from '../components/media/BulkActionToolbar';
import { BulkLocationDialog } from '../components/media/BulkLocationDialog';
import { BulkTagsDialog } from '../components/media/BulkTagsDialog';
import { AddToAlbumDialog } from '../components/album/AddToAlbumDialog';
import { patchMedia as patchMediaApi } from '../services/media';
import type { MediaItem } from '../types/media';

// ---------------------------------------------------------------------------
// Inline thumbnail tile — lightweight version for the home grid
// ---------------------------------------------------------------------------

interface HomeTileProps {
  item: MediaItem;
  onSelect: () => void;
  onToggleFavorite: (item: MediaItem) => void;
  isSelected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string) => void;
  selectionMode: boolean;
}

function HomeTile({
  item,
  onSelect,
  onToggleFavorite,
  isSelected,
  anySelected,
  onToggleSelect,
  selectionMode,
}: HomeTileProps) {
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
        // Selected state: inset primary-colour border + slight dim
        outline: isSelected ? `2px solid ${theme.palette.primary.main}` : 'none',
        outlineOffset: '-2px',
        opacity: isSelected ? 0.85 : 1,
        transition: 'outline 0.1s, opacity 0.1s',
        '&:hover .home-tile-overlay': { opacity: 1 },
        '&:hover .home-tile-fav': { opacity: 1 },
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

      {/* Selection checkbox — shown on hover (desktop) or always on mobile / when any item selected */}
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

      {/* Subtle gradient — visible on hover or when favorited */}
      <Box
        className="home-tile-overlay"
        sx={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 50%)',
          opacity: item.favorite ? 1 : 0,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
        }}
      />

      <ImageListItemBar
        className="home-tile-fav"
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
// Main page
// ---------------------------------------------------------------------------

// AppBar height to offset sticky day headers
const APP_BAR_HEIGHT = 64;

export default function HomePage() {
  const theme = useTheme();
  const { activeCircle, activeCircleId, activeCircleRole, loading: circleLoading } = useCircle();

  // Params for infinite scroll — memoized so reference is stable when circleId unchanged
  const mediaParams = useMemo(
    () => ({
      circleId: activeCircleId ?? undefined,
      sortBy: 'capturedAt' as const,
      sortOrder: 'desc' as const,
    }),
    [activeCircleId],
  );

  const { items, loadMore, hasMore, isLoading, error, reset } = useInfiniteMedia(
    mediaParams,
    50,
    !!activeCircleId,
  );

  // Sentinel element for infinite scroll trigger
  const sentinelRef = useRef<HTMLDivElement>(null);
  useIntersectionObserver(sentinelRef, loadMore, {
    rootMargin: '300px',
    disabled: !hasMore || isLoading || !activeCircleId,
  });

  // Lightbox state
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Detail drawer state
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Upload dialog state
  const [uploadOpen, setUploadOpen] = useState(false);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

  // Bulk dialog state
  const [bulkLocationOpen, setBulkLocationOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);

  // Snackbar state
  const [snackbar, setSnackbar] = useState<{
    message: string;
    severity: 'success' | 'error';
  } | null>(null);

  // Optimistic patches for favorites without full refetch
  const [localPatches, setLocalPatches] = useState<Record<string, Partial<MediaItem>>>({});

  const mergedItems = useMemo(
    () =>
      items.map((item) =>
        localPatches[item.id] ? { ...item, ...localPatches[item.id] } : item,
      ),
    [items, localPatches],
  );

  const grouped = useMemo(() => groupByDay(mergedItems), [mergedItems]);

  const handleToggleFavorite = useCallback(async (item: MediaItem) => {
    const next = !item.favorite;
    setLocalPatches((prev) => ({ ...prev, [item.id]: { favorite: next } }));
    try {
      await patchMediaApi(item.id, { favorite: next });
    } catch {
      // Rollback on failure
      setLocalPatches((prev) => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
    }
  }, []);

  const handleItemUpdated = useCallback((updated: MediaItem) => {
    setLocalPatches((prev) => ({ ...prev, [updated.id]: updated }));
  }, []);

  const handleUploadSuccess = useCallback(() => {
    setUploadOpen(false);
    setLocalPatches({});
    reset();
  }, [reset]);

  // Selection handlers
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

  const handleBulkSuccess = useCallback(
    (message: string) => {
      setSnackbar({ message, severity: 'success' });
      setSelected(new Set());
      setSelectionMode(false);
      setLocalPatches({});
      reset();
    },
    [reset],
  );

  // -----------------------------------------------------------------------
  // Derived display flags
  // -----------------------------------------------------------------------
  const showNoCircle = !activeCircle && !circleLoading;
  const showFirstLoad = isLoading && items.length === 0;
  const showEmpty = !isLoading && !error && items.length === 0 && !!activeCircle;

  // Filters for AddToAlbumDialog — strip pagination/sort from mediaParams
  const albumFilters = useMemo(
    () => ({
      circleId: activeCircleId ?? undefined,
    }),
    [activeCircleId],
  );

  return (
    <Box sx={{ minHeight: '100vh', pb: { xs: 10, sm: 4 } }}>
      {/* No active circle */}
      {showNoCircle && (
        <Box sx={{ p: { xs: 2, md: 3 } }}>
          <Alert severity="info">
            Select or create a circle to get started.{' '}
            <Link component={RouterLink} to="/circles" underline="always">
              Go to Circles
            </Link>
          </Alert>
        </Box>
      )}

      {/* Error */}
      {error && (
        <Box sx={{ p: { xs: 2, md: 3 } }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      )}

      {/* First-page loading skeletons */}
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

      {/* Empty state */}
      {showEmpty && (
        <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
          <PhotoLibraryIcon sx={{ fontSize: 72, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" gutterBottom>
            No memories here yet
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Upload your first photo or video to {activeCircle?.name} to get started.
          </Typography>
          <Button variant="contained" startIcon={<UploadIcon />} onClick={() => setUploadOpen(true)}>
            Upload Media
          </Button>
        </Box>
      )}

      {/* Day-grouped photo grid */}
      {!showFirstLoad && items.length > 0 && (
        <Box sx={{ px: { xs: 1, sm: 2 }, pt: { xs: 1, sm: 2 } }}>
          {grouped.map((group) => (
            <Box key={group.key} sx={{ mb: 3 }}>
              {/* Sticky day header with select-all / clear controls */}
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
                <Typography
                  variant="subtitle2"
                  sx={{ fontWeight: 600, color: 'text.primary' }}
                >
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

              {/* Responsive square thumbnail grid */}
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
                    <HomeTile
                      key={item.id}
                      item={item}
                      onSelect={() =>
                        setLightboxIndex(globalIndex !== -1 ? globalIndex : 0)
                      }
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

          {/* Infinite scroll sentinel */}
          <Box ref={sentinelRef} sx={{ height: 1 }} />

          {/* Bottom loading spinner while fetching next page */}
          {isLoading && items.length > 0 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          )}

          {/* End-of-list hint */}
          {!hasMore && !isLoading && items.length > 0 && (
            <Box sx={{ textAlign: 'center', py: 3 }}>
              <Typography variant="caption" color="text.disabled">
                All memories loaded
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {/* Upload FAB */}
      {activeCircle && (
        <Fab
          color="primary"
          aria-label="Upload media"
          onClick={() => setUploadOpen(true)}
          sx={{ position: 'fixed', bottom: { xs: 72, sm: 24 }, right: 24, zIndex: 20 }}
        >
          <UploadIcon />
        </Fab>
      )}

      {/* Lightbox */}
      <MediaLightbox
        items={mergedItems}
        index={lightboxIndex}
        onIndexChange={(i) => { setLightboxIndex(i); setDrawerOpen(false); }}
        onClose={() => setLightboxIndex(null)}
        onOpenProperties={(item) => { setDetailItem(item); setDrawerOpen(true); }}
        onItemUpdated={handleItemUpdated}
      />

      {/* Detail drawer */}
      <MediaDetailDrawer
        item={detailItem}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onItemUpdated={handleItemUpdated}
      />

      {/* Upload dialog */}
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircleId ?? undefined}
      />

      {/* Bulk action toolbar — rendered when anything is selected */}
      {activeCircle && (
        <BulkActionToolbar
          selected={selected}
          circleId={activeCircle.id}
          activeCircleRole={activeCircleRole}
          onClear={handleClearSelection}
          onOpenLocation={() => setBulkLocationOpen(true)}
          onOpenTags={() => setBulkTagsOpen(true)}
          onOpenAlbum={() => setAddToAlbumOpen(true)}
          onSuccess={handleBulkSuccess}
          onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
        />
      )}

      {/* Bulk location dialog */}
      {activeCircle && (
        <BulkLocationDialog
          open={bulkLocationOpen}
          onClose={() => setBulkLocationOpen(false)}
          circleId={activeCircle.id}
          ids={Array.from(selected)}
          onSuccess={(msg) => {
            setBulkLocationOpen(false);
            handleBulkSuccess(msg);
          }}
        />
      )}

      {/* Bulk tags dialog */}
      {activeCircle && (
        <BulkTagsDialog
          open={bulkTagsOpen}
          onClose={() => setBulkTagsOpen(false)}
          circleId={activeCircle.id}
          ids={Array.from(selected)}
          onSuccess={(msg) => {
            setBulkTagsOpen(false);
            handleBulkSuccess(msg);
          }}
        />
      )}

      {/* Add to album dialog */}
      {activeCircle && (
        <AddToAlbumDialog
          open={addToAlbumOpen}
          onClose={() => setAddToAlbumOpen(false)}
          circleId={activeCircle.id}
          selectedIds={Array.from(selected)}
          filters={albumFilters}
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
