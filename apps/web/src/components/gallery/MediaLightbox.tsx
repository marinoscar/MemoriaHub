import { useCallback } from 'react';
import {
  Dialog,
  Box,
  IconButton,
  useTheme,
  useMediaQuery,
  CircularProgress,
} from '@mui/material';
import {
  Close as CloseIcon,
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
} from '@mui/icons-material';
import type { MediaAssetDTO } from '@memoriahub/shared';
import { useKeyboardNavigation } from '../../hooks';
import { MediaMetadata } from './MediaMetadata';

interface MediaLightboxProps {
  /** Array of media assets */
  media: MediaAssetDTO[];
  /** Index of the currently selected media */
  selectedIndex: number;
  /** Handler for closing the lightbox */
  onClose: () => void;
  /** Handler for navigation */
  onNavigate: (mediaId: string) => void;
}

/**
 * Full-screen lightbox for viewing media
 * Supports keyboard navigation, prev/next buttons, and metadata panel
 */
export function MediaLightbox({
  media,
  selectedIndex,
  onClose,
  onNavigate,
}: MediaLightboxProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const currentMedia = media[selectedIndex];
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex < media.length - 1;

  const handlePrevious = useCallback(() => {
    if (hasPrevious) {
      onNavigate(media[selectedIndex - 1].id);
    }
  }, [hasPrevious, media, selectedIndex, onNavigate]);

  const handleNext = useCallback(() => {
    if (hasNext) {
      onNavigate(media[selectedIndex + 1].id);
    }
  }, [hasNext, media, selectedIndex, onNavigate]);

  // Keyboard navigation
  useKeyboardNavigation({
    onNext: handleNext,
    onPrevious: handlePrevious,
    onClose,
    enabled: true,
  });

  if (!currentMedia) {
    return null;
  }

  const isVideo = currentMedia.mediaType === 'video';
  const mediaUrl = currentMedia.previewUrl || currentMedia.originalUrl;

  return (
    <Dialog
      open={true}
      onClose={onClose}
      maxWidth={false}
      fullScreen
      PaperProps={{
        sx: {
          bgcolor: 'black',
        },
      }}
    >
      {/* Close button */}
      <IconButton
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          color: 'white',
          bgcolor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 10,
          '&:hover': {
            bgcolor: 'rgba(0, 0, 0, 0.7)',
          },
        }}
        aria-label="Close"
      >
        <CloseIcon />
      </IconButton>

      {/* Main content area */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          height: '100%',
          width: '100%',
        }}
      >
        {/* Media display area */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
            minHeight: 0,
          }}
        >
          {/* Previous button */}
          {hasPrevious && (
            <IconButton
              onClick={handlePrevious}
              sx={{
                position: 'absolute',
                left: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'white',
                bgcolor: 'rgba(0, 0, 0, 0.5)',
                zIndex: 5,
                '&:hover': {
                  bgcolor: 'rgba(0, 0, 0, 0.7)',
                },
              }}
              aria-label="Previous"
            >
              <PrevIcon fontSize="large" />
            </IconButton>
          )}

          {/* Next button */}
          {hasNext && (
            <IconButton
              onClick={handleNext}
              sx={{
                position: 'absolute',
                right: isMobile ? 8 : 288 + 8, // Account for metadata panel on desktop
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'white',
                bgcolor: 'rgba(0, 0, 0, 0.5)',
                zIndex: 5,
                '&:hover': {
                  bgcolor: 'rgba(0, 0, 0, 0.7)',
                },
              }}
              aria-label="Next"
            >
              <NextIcon fontSize="large" />
            </IconButton>
          )}

          {/* Media content */}
          {isVideo ? (
            <Box
              component="video"
              src={mediaUrl}
              controls
              autoPlay
              sx={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
              }}
            />
          ) : (
            <Box
              component="img"
              src={mediaUrl}
              alt={currentMedia.originalFilename}
              sx={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
              }}
              onError={(e) => {
                // Fallback to original URL if preview fails
                const img = e.target as HTMLImageElement;
                if (img.src !== currentMedia.originalUrl) {
                  img.src = currentMedia.originalUrl;
                }
              }}
            />
          )}

          {/* Loading indicator (shown briefly while image loads) */}
          <CircularProgress
            sx={{
              position: 'absolute',
              color: 'white',
              opacity: 0.5,
              pointerEvents: 'none',
            }}
          />
        </Box>

        {/* Metadata panel */}
        <MediaMetadata media={currentMedia} />
      </Box>

      {/* Counter */}
      <Box
        sx={{
          position: 'absolute',
          bottom: isMobile ? 'auto' : 16,
          top: isMobile ? 8 : 'auto',
          left: '50%',
          transform: 'translateX(-50%)',
          color: 'white',
          bgcolor: 'rgba(0, 0, 0, 0.5)',
          px: 2,
          py: 0.5,
          borderRadius: 2,
          fontSize: '0.875rem',
          zIndex: 10,
        }}
      >
        {selectedIndex + 1} / {media.length}
      </Box>
    </Dialog>
  );
}
