import { Typography, Button, Paper } from '@mui/material';
import { CloudUpload as UploadIcon, PhotoLibrary as EmptyIcon } from '@mui/icons-material';

interface EmptyGalleryProps {
  /** Click handler for upload button */
  onUploadClick: () => void;
}

/**
 * Empty state shown when a library has no media
 */
export function EmptyGallery({ onUploadClick }: EmptyGalleryProps) {
  return (
    <Paper
      sx={{
        p: 6,
        textAlign: 'center',
        bgcolor: 'background.default',
      }}
    >
      <EmptyIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        No photos or videos yet
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Upload some photos or videos to get started.
      </Typography>
      <Button
        variant="contained"
        startIcon={<UploadIcon />}
        onClick={onUploadClick}
      >
        Upload Photos
      </Button>
    </Paper>
  );
}
