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
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  PhotoLibrary as PhotoLibraryIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useTheme } from '@mui/material/styles';
import { useCircle } from '../hooks/useCircle';
import { useInfiniteMedia } from '../hooks/useInfiniteMedia';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { groupByDay } from '../utils/groupByDay';
import { MediaLightbox } from '../components/media/MediaLightbox';
import { MediaUploadDialog } from '../components/media/MediaUploadDialog';
import { patchMedia as patchMediaApi } from '../services/media';
import type { MediaItem } from '../types/media';

// ---------------------------------------------------------------------------
// Inline thumbnail tile — lightweight version for the home grid
// ---------------------------------------------------------------------------

interface HomeTileProps {
  item: MediaItem;
  onSelect: () => void;
  onToggleFavorite: (item: MediaItem) => void;
}

function HomeTile({ item, onSelect, onToggleFavorite }: HomeTileProps) {
  const theme = useTheme();
  const [imgError, setImgError] = useState(false);

  return (
    <ImageListItem
      onClick={onSelect}
      sx={{
        position: 'relative',
        cursor: 'pointer',
        overflow: 'hidden',
        borderRadius: 0.5,
        aspectRatio: '1',
        backgroundColor: theme.palette.grey[900],
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
  const { activeCircle, activeCircleId, loading: circleLoading } = useCircle();

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

  // Upload dialog state
  const [uploadOpen, setUploadOpen] = useState(false);

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

  // -----------------------------------------------------------------------
  // Derived display flags
  // -----------------------------------------------------------------------
  const showNoCircle = !activeCircle && !circleLoading;
  const showFirstLoad = isLoading && items.length === 0;
  const showEmpty = !isLoading && !error && items.length === 0 && !!activeCircle;

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
              {/* Sticky day header */}
              <Typography
                variant="subtitle2"
                sx={{
                  position: 'sticky',
                  top: APP_BAR_HEIGHT,
                  zIndex: 10,
                  py: 0.75,
                  px: 0.5,
                  mb: 0.5,
                  fontWeight: 600,
                  color: 'text.primary',
                  backgroundColor: theme.palette.background.default,
                  borderBottom: `1px solid ${theme.palette.divider}`,
                }}
              >
                {group.label}
              </Typography>

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
        onIndexChange={(i) => setLightboxIndex(i)}
        onClose={() => setLightboxIndex(null)}
        onOpenProperties={() => {
          /* detail drawer not shown on home */
        }}
        onItemUpdated={handleItemUpdated}
      />

      {/* Upload dialog */}
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircleId ?? undefined}
      />
    </Box>
  );
}
