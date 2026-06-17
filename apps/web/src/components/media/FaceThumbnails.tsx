import {
  Box,
  Typography,
  Chip,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
  Skeleton,
  Stack,
} from '@mui/material';
import { Face as FaceIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { useMediaFaces } from '../../hooks/useMediaFaces';
import type { MediaFaceStatusType, DetectedFaceDto } from '../../services/face';

function statusChipProps(status: MediaFaceStatusType): {
  label: string;
  color: 'success' | 'warning' | 'info' | 'default' | 'error';
} {
  switch (status) {
    case 'processed':
      return { label: 'Processed', color: 'success' };
    case 'pending':
      return { label: 'Pending', color: 'warning' };
    case 'processing':
      return { label: 'Processing', color: 'info' };
    case 'no_faces':
      return { label: 'No Faces', color: 'default' };
    case 'failed':
      return { label: 'Failed', color: 'error' };
    default:
      return { label: 'Not Processed', color: 'default' };
  }
}

interface FaceThumbnailsProps {
  mediaId: string;
  mediaType?: string;
  thumbnailUrl?: string;
}

export function FaceThumbnails({ mediaId, mediaType, thumbnailUrl }: FaceThumbnailsProps) {
  const theme = useTheme();
  const { faces, status, loading, error, rerun, rerunLoading } = useMediaFaces(mediaId);

  if (mediaType === 'video') return null;

  if (loading) {
    return <Skeleton variant="rectangular" height={80} sx={{ borderRadius: 1 }} />;
  }

  const chipProps = status
    ? statusChipProps(status.status)
    : { label: 'Not Processed', color: 'default' as const };

  return (
    <Box>
      {/* Status row */}
      <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip label={chipProps.label} color={chipProps.color} size="small" icon={<FaceIcon />} />
        {status?.providerKey && (
          <Typography variant="caption" color="text.secondary">
            {status.providerKey}
            {status.modelVersion ? ` · ${status.modelVersion}` : ''}
          </Typography>
        )}
        {status?.processedAt && (
          <Typography variant="caption" color="text.secondary">
            {new Date(status.processedAt).toLocaleDateString()}
          </Typography>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {/* Image with face box overlays */}
      {thumbnailUrl && (
        <Box sx={{ position: 'relative', display: 'inline-block', width: '100%', mb: 1 }}>
          <Box
            component="img"
            src={thumbnailUrl}
            alt="Media thumbnail"
            sx={{ width: '100%', display: 'block', borderRadius: 1 }}
          />
          {faces.map((face) => (
            <FaceBox key={face.id} face={face} theme={theme} />
          ))}
        </Box>
      )}

      {/* Face count */}
      {faces.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {faces.length} face{faces.length !== 1 ? 's' : ''} detected
        </Typography>
      )}

      {/* Rerun button */}
      <Button
        size="small"
        variant="outlined"
        startIcon={rerunLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
        onClick={() => void rerun()}
        disabled={rerunLoading}
      >
        Re-run face detection
      </Button>
    </Box>
  );
}

function FaceBox({
  face,
  theme,
}: {
  face: DetectedFaceDto;
  theme: Theme;
}) {
  const { x, y, w, h } = face.boundingBox;
  const confidenceLabel =
    face.confidence !== null
      ? `${Math.round(face.confidence * 100)}% confidence`
      : 'Face detected';

  return (
    <Tooltip title={confidenceLabel} placement="top">
      <Box
        sx={{
          position: 'absolute',
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: `${w * 100}%`,
          height: `${h * 100}%`,
          border: `2px solid ${theme.palette.secondary.main}`,
          boxSizing: 'border-box',
          cursor: 'default',
          '&:hover': {
            borderColor: theme.palette.secondary.light,
            backgroundColor: `${theme.palette.secondary.main}22`,
          },
        }}
      >
        {/* Phase 3 placeholder: unassigned/assigned label */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
          }}
        >
          <Chip
            label={face.personId ? 'Assigned' : 'Unassigned'}
            size="small"
            sx={{
              height: 16,
              fontSize: '0.6rem',
              opacity: 0.85,
              backgroundColor: face.personId
                ? theme.palette.success.main
                : theme.palette.grey[700],
              color: 'white',
              borderRadius: 0.5,
            }}
          />
        </Box>
      </Box>
    </Tooltip>
  );
}
