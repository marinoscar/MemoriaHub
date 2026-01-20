import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Divider,
  useTheme,
  useMediaQuery,
  Button,
  TextField,
  Stack,
  CircularProgress,
} from '@mui/material';
import {
  CalendarToday as DateIcon,
  CameraAlt as CameraIcon,
  LocationOn as LocationIcon,
  Straighten as DimensionsIcon,
  Storage as SizeIcon,
  Timer as DurationIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import type { MediaAssetDTO } from '@memoriahub/shared';
import { mediaApi } from '../../services/api/media.api';

interface MediaMetadataProps {
  /** Media asset to display metadata for */
  media: MediaAssetDTO;
  /** Callback when metadata is saved */
  onSave?: (updatedMedia: MediaAssetDTO) => void;
  /** Callback when save fails */
  onError?: (error: string) => void;
}

/**
 * Format date for display
 */
function formatDate(dateString: string | null): string {
  if (!dateString) return 'Not set';
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
    return 'Not set';
  }
}

/**
 * Format ISO date to datetime-local input format
 */
function formatDateForInput(isoString: string | null): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    // Format as YYYY-MM-DDTHH:mm for datetime-local input
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  } catch {
    return '';
  }
}

/**
 * Convert datetime-local to ISO string
 */
function formatDateForApi(datetimeLocal: string): string {
  return new Date(datetimeLocal).toISOString();
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
 * Metadata row component (read-only)
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
 * Editable field component
 */
function EditableField({
  icon,
  label,
  value,
  isEditing,
  onChange,
  type = 'text',
  placeholder,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  isEditing: boolean;
  onChange: (value: string) => void;
  type?: 'text' | 'datetime-local';
  placeholder?: string;
}) {
  if (!isEditing) {
    return (
      <MetadataRow
        icon={icon}
        label={label}
        value={value || 'Not set'}
      />
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 1.5 }}>
      <Box sx={{ color: 'text.secondary', mr: 1.5, mt: 1 }}>
        {icon}
      </Box>
      <TextField
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        size="small"
        fullWidth
        placeholder={placeholder}
        InputLabelProps={{ shrink: true }}
        sx={{ flex: 1 }}
      />
    </Box>
  );
}

/**
 * Metadata panel for media lightbox
 * Displays filename, date, location, camera, dimensions, file size
 * Supports editing of captured date and location fields
 */
export function MediaMetadata({ media, onSave, onError }: MediaMetadataProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Editing state
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Form values (editable fields only)
  const [editedValues, setEditedValues] = useState({
    capturedAtUtc: '',
    country: '',
    state: '',
    city: '',
  });

  // Initialize form values when media changes
  useEffect(() => {
    setEditedValues({
      capturedAtUtc: formatDateForInput(media.capturedAtUtc),
      country: media.country || '',
      state: media.state || '',
      city: media.city || '',
    });
    // Exit edit mode when media changes (navigating to different item)
    setIsEditing(false);
  }, [media.id, media.capturedAtUtc, media.country, media.state, media.city]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const result = await mediaApi.updateMetadata(media.id, {
        capturedAtUtc: editedValues.capturedAtUtc
          ? formatDateForApi(editedValues.capturedAtUtc)
          : undefined,
        country: editedValues.country || null,
        state: editedValues.state || null,
        city: editedValues.city || null,
      });

      if (result.updated.length > 0) {
        // Refetch the updated asset
        const updatedAsset = await mediaApi.getMedia(media.id);
        onSave?.(updatedAsset);
        setIsEditing(false);
      } else if (result.failed.length > 0) {
        onError?.(result.failed[0].error);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsResetting(true);
    try {
      const updatedAsset = await mediaApi.resetMetadata(media.id);
      onSave?.(updatedAsset);
      setIsEditing(false);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to reset');
    } finally {
      setIsResetting(false);
    }
  };

  const handleCancel = () => {
    // Reset to original values
    setEditedValues({
      capturedAtUtc: formatDateForInput(media.capturedAtUtc),
      country: media.country || '',
      state: media.state || '',
      city: media.city || '',
    });
    setIsEditing(false);
  };

  const cameraInfo = [media.cameraMake, media.cameraModel].filter(Boolean).join(' ');
  const dimensions = media.width && media.height ? `${media.width} x ${media.height}` : null;
  const isVideo = media.mediaType === 'video';
  const isLoading = isSaving || isResetting;

  return (
    <Box
      sx={{
        p: 2,
        bgcolor: 'background.paper',
        width: isMobile ? '100%' : 280,
        maxHeight: isMobile ? 300 : '100%',
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

      {/* Capture date - EDITABLE */}
      <EditableField
        icon={<DateIcon fontSize="small" />}
        label="Captured"
        value={isEditing ? editedValues.capturedAtUtc : formatDate(media.capturedAtUtc)}
        isEditing={isEditing}
        onChange={(val) => setEditedValues((prev) => ({ ...prev, capturedAtUtc: val }))}
        type={isEditing ? 'datetime-local' : 'text'}
      />

      {/* Location fields - EDITABLE (shown as 3 separate fields) */}
      <EditableField
        icon={<LocationIcon fontSize="small" />}
        label="Country"
        value={isEditing ? editedValues.country : (media.country || '')}
        isEditing={isEditing}
        onChange={(val) => setEditedValues((prev) => ({ ...prev, country: val }))}
        placeholder="e.g., United States"
      />

      <EditableField
        icon={<Box sx={{ width: 20 }} />}
        label="State"
        value={isEditing ? editedValues.state : (media.state || '')}
        isEditing={isEditing}
        onChange={(val) => setEditedValues((prev) => ({ ...prev, state: val }))}
        placeholder="e.g., California"
      />

      <EditableField
        icon={<Box sx={{ width: 20 }} />}
        label="City"
        value={isEditing ? editedValues.city : (media.city || '')}
        isEditing={isEditing}
        onChange={(val) => setEditedValues((prev) => ({ ...prev, city: val }))}
        placeholder="e.g., San Francisco"
      />

      {/* Camera - READ-ONLY */}
      {cameraInfo && (
        <MetadataRow
          icon={<CameraIcon fontSize="small" />}
          label="Camera"
          value={cameraInfo}
        />
      )}

      {/* Dimensions - READ-ONLY */}
      {dimensions && (
        <MetadataRow
          icon={<DimensionsIcon fontSize="small" />}
          label="Dimensions"
          value={dimensions}
        />
      )}

      {/* Duration (video only) - READ-ONLY */}
      {isVideo && media.durationSeconds && (
        <MetadataRow
          icon={<DurationIcon fontSize="small" />}
          label="Duration"
          value={formatDuration(media.durationSeconds)}
        />
      )}

      {/* File size - READ-ONLY */}
      <MetadataRow
        icon={<SizeIcon fontSize="small" />}
        label="File size"
        value={formatFileSize(media.fileSize)}
      />

      {/* Action buttons */}
      <Divider sx={{ my: 2 }} />

      {!isEditing ? (
        <Button
          variant="outlined"
          size="small"
          startIcon={<EditIcon />}
          onClick={() => setIsEditing(true)}
          fullWidth
        >
          Edit Metadata
        </Button>
      ) : (
        <Stack spacing={1}>
          <Button
            variant="contained"
            size="small"
            onClick={handleSave}
            disabled={isLoading}
            fullWidth
          >
            {isSaving ? <CircularProgress size={20} /> : 'Save Changes'}
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={handleReset}
            disabled={isLoading}
            fullWidth
            color="warning"
          >
            {isResetting ? <CircularProgress size={20} /> : 'Reset to Defaults'}
          </Button>
          <Button
            size="small"
            onClick={handleCancel}
            disabled={isLoading}
            fullWidth
          >
            Cancel
          </Button>
        </Stack>
      )}
    </Box>
  );
}
