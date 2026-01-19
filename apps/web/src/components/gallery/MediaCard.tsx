import { useState } from 'react';
import { Box, Skeleton } from '@mui/material';
import {
  PlayCircleOutline as PlayIcon,
  BrokenImage as BrokenImageIcon,
} from '@mui/icons-material';
import type { MediaAssetDTO } from '@memoriahub/shared';

interface MediaCardProps {
  /** Media asset to display */
  media: MediaAssetDTO;
  /** Click handler */
  onClick: (mediaId: string) => void;
}

/**
 * Thumbnail card for a single media asset
 * Square aspect ratio with lazy loading and video indicator
 */
export function MediaCard({ media, onClick }: MediaCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  const isVideo = media.mediaType === 'video';
  const thumbnailUrl = media.thumbnailUrl;

  const handleClick = () => {
    onClick(media.id);
  };

  const handleImageLoad = () => {
    setImageLoaded(true);
  };

  const handleImageError = () => {
    setImageError(true);
    setImageLoaded(true);
  };

  return (
    <Box
      onClick={handleClick}
      sx={{
        aspectRatio: '1',
        position: 'relative',
        overflow: 'hidden',
        cursor: 'pointer',
        bgcolor: 'action.hover',
        borderRadius: 1,
        '&:hover': {
          '& img': {
            transform: 'scale(1.05)',
          },
          '& .play-icon': {
            transform: 'translate(-50%, -50%) scale(1.1)',
          },
        },
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      aria-label={`View ${media.originalFilename}`}
    >
      {/* Loading skeleton */}
      {!imageLoaded && (
        <Skeleton
          variant="rectangular"
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
          }}
          animation="wave"
        />
      )}

      {/* Thumbnail image or fallback */}
      {thumbnailUrl && !imageError ? (
        <Box
          component="img"
          src={thumbnailUrl}
          alt={media.originalFilename}
          onLoad={handleImageLoad}
          onError={handleImageError}
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transition: 'transform 0.2s ease-in-out',
            opacity: imageLoaded ? 1 : 0,
          }}
        />
      ) : imageLoaded ? (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'action.disabledBackground',
          }}
        >
          <BrokenImageIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
        </Box>
      ) : null}

      {/* Video play icon overlay */}
      {isVideo && imageLoaded && !imageError && (
        <PlayIcon
          className="play-icon"
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            fontSize: 48,
            color: 'white',
            filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
            transition: 'transform 0.2s ease-in-out',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Video duration badge */}
      {isVideo && media.durationSeconds && imageLoaded && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 4,
            right: 4,
            bgcolor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            px: 0.75,
            py: 0.25,
            borderRadius: 0.5,
            fontSize: '0.75rem',
            fontWeight: 500,
          }}
        >
          {formatDuration(media.durationSeconds)}
        </Box>
      )}
    </Box>
  );
}

/**
 * Format duration in seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
