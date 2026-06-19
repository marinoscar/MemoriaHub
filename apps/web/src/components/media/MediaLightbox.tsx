import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Dialog,
  Box,
  IconButton,
  Typography,
  CircularProgress,
  Stack,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import {
  Close as CloseIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  Download as DownloadIcon,
  InfoOutlined,
  ChevronLeft,
  ChevronRight,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { MediaItem } from '../../types/media';
import { getMedia, patchMedia as patchMediaApi } from '../../services/media';
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

  // Suppress "unused variable" warnings for parameters wired in later commits
  void patchMediaApi;

  const item = index !== null ? items[index] ?? null : null;

  // Full item (with downloadUrl) fetched from API
  const [fullItem, setFullItem] = useState<MediaItem | null>(null);
  // True once the full-res image has loaded in the browser
  const [fullResLoaded, setFullResLoaded] = useState(false);
  // Zoom state — added in commit 7
  const [zoomed, setZoomed] = useState(false);
  // Controls visibility — added in commit 4
  const [controlsVisible, setControlsVisible] = useState(true);

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
      PaperProps={{ sx: { backgroundColor: 'black', overflow: 'hidden' } }}
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
              {item.title ?? item.originalFilename}
            </Typography>

            <Stack direction="row" spacing={0.5} alignItems="center">
              <Tooltip title={displayItem.favorite ? 'Remove from favorites' : 'Add to favorites'}>
                <IconButton
                  aria-label="Toggle favorite"
                  onClick={() => void handleToggleFavorite()}
                  sx={{
                    color: displayItem.favorite ? theme.palette.warning.main : 'white',
                  }}
                >
                  {displayItem.favorite ? <StarIcon /> : <StarBorderIcon />}
                </IconButton>
              </Tooltip>

              {downloadUrl && (
                <Tooltip title="Download original">
                  <IconButton
                    component="a"
                    href={downloadUrl}
                    download
                    aria-label="Download original"
                    sx={{ color: 'white' }}
                  >
                    <DownloadIcon />
                  </IconButton>
                </Tooltip>
              )}

              <Tooltip title="Open properties panel">
                <IconButton
                  aria-label="Open properties panel"
                  onClick={() => onOpenProperties(displayItem)}
                  sx={{ color: 'white' }}
                >
                  <InfoOutlined />
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
                    title={item.title ?? item.originalFilename}
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
                    alt={item.title ?? item.originalFilename}
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
                    alt={item.title ?? item.originalFilename}
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
            }}
          >
            <ChevronRight />
          </IconButton>
        </Box>
      </Box>
    </Dialog>
  );
}
