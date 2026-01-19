import { Box, Typography, Divider, useTheme, useMediaQuery } from '@mui/material';
import {
  CalendarToday as DateIcon,
  CameraAlt as CameraIcon,
  LocationOn as LocationIcon,
  Straighten as DimensionsIcon,
  Storage as SizeIcon,
  Timer as DurationIcon,
} from '@mui/icons-material';
import type { MediaAssetDTO } from '@memoriahub/shared';

interface MediaMetadataProps {
  /** Media asset to display metadata for */
  media: MediaAssetDTO;
}

/**
 * Format date for display
 */
function formatDate(dateString: string | null): string {
  if (!dateString) return 'Unknown';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown';
  }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

/**
 * Format location string from components
 */
function formatLocation(media: MediaAssetDTO): string | null {
  const parts = [media.city, media.state, media.country].filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join(', ');
}

/**
 * Metadata row component
 */
function MetadataRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 1.5 }}>
      <Box sx={{ color: 'text.secondary', mr: 1.5, mt: 0.25 }}>
        {icon}
      </Box>
      <Box>
        <Typography variant="caption" color="text.secondary" display="block">
          {label}
        </Typography>
        <Typography variant="body2">
          {value}
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * Metadata panel for media lightbox
 * Displays filename, date, location, camera, dimensions, file size
 */
export function MediaMetadata({ media }: MediaMetadataProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const location = formatLocation(media);
  const cameraInfo = [media.cameraMake, media.cameraModel].filter(Boolean).join(' ');
  const dimensions = media.width && media.height ? `${media.width} x ${media.height}` : null;
  const isVideo = media.mediaType === 'video';

  return (
    <Box
      sx={{
        p: 2,
        bgcolor: 'background.paper',
        width: isMobile ? '100%' : 280,
        maxHeight: isMobile ? 200 : '100%',
        overflowY: 'auto',
      }}
    >
      {/* Filename */}
      <Typography
        variant="subtitle2"
        sx={{
          mb: 2,
          wordBreak: 'break-word',
          fontWeight: 600,
        }}
      >
        {media.originalFilename}
      </Typography>

      <Divider sx={{ mb: 2 }} />

      {/* Capture date */}
      <MetadataRow
        icon={<DateIcon fontSize="small" />}
        label="Captured"
        value={formatDate(media.capturedAtUtc)}
      />

      {/* Location */}
      {location && (
        <MetadataRow
          icon={<LocationIcon fontSize="small" />}
          label="Location"
          value={location}
        />
      )}

      {/* Camera */}
      {cameraInfo && (
        <MetadataRow
          icon={<CameraIcon fontSize="small" />}
          label="Camera"
          value={cameraInfo}
        />
      )}

      {/* Dimensions */}
      {dimensions && (
        <MetadataRow
          icon={<DimensionsIcon fontSize="small" />}
          label="Dimensions"
          value={dimensions}
        />
      )}

      {/* Duration (video only) */}
      {isVideo && media.durationSeconds && (
        <MetadataRow
          icon={<DurationIcon fontSize="small" />}
          label="Duration"
          value={formatDuration(media.durationSeconds)}
        />
      )}

      {/* File size */}
      <MetadataRow
        icon={<SizeIcon fontSize="small" />}
        label="File size"
        value={formatFileSize(media.fileSize)}
      />
    </Box>
  );
}
