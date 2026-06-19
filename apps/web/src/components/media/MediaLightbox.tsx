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
  void onIndexChange;
  void onOpenProperties;
  void onItemUpdated;
  void isMobile;
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

  // Suppress unused-variable warnings — filled in later
  void zoomed;
  void controlsVisible;
  void hideTimerRef;
  void swipeRef;
  void setZoomed;
  void setControlsVisible;

  // --- Fetch full item & prefetch neighbors ---
  useEffect(() => {
    if (index === null || !item) {
      setFullItem(null);
      setFullResLoaded(false);
      return;
    }

    // Reset per-item state
    setFullResLoaded(false);

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
      >
        {/* Inner content — stop propagation so clicks on controls don't close */}
        <Box
          sx={{ position: 'relative', width: '100%', height: '100%' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Placeholder for control bar — added in commit 4 */}

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
          >
            {item.type === 'video' ? (
              /* Video branch — expanded in commit 5 */
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

          {/* Placeholder for chevrons — added in commit 3 */}
        </Box>
      </Box>
    </Dialog>
  );
}
