import { useState, useRef } from 'react';
import { Button, Box, Typography, CircularProgress } from '@mui/material';
import UploadIcon from '@mui/icons-material/CloudUpload';
import { uploadMyAvatar } from '../../services/userProfile';
import type { UserProfile } from '../../services/userProfile';

interface ImageUploadProps {
  /**
   * Receives the FULL refreshed profile returned by the API — not a bare URL.
   * The upload sets `avatarSource='upload'` server-side, so the caller needs
   * the new source and cache-busted `avatarUrl`, not just an image address.
   */
  onUpload: (profile: UserProfile) => void;
  disabled?: boolean;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — matches the API's limit
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
];

/**
 * One-step avatar upload: pick a file, POST it as-is.
 *
 * The `/profile` page uses its own picker + square-crop flow instead, since the
 * stored avatar is square; this stays as the no-crop path for surfaces that
 * only need "replace my picture with this file".
 */
export function ImageUpload({ onUpload, disabled = false }: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Please select a valid image file (JPEG, PNG, GIF, WebP, or HEIC)');
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setError('File size must be less than 5MB');
      return;
    }

    setError(null);
    setIsUploading(true);

    try {
      const profile = await uploadMyAvatar(file, file.name);
      onUpload(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
    } finally {
      setIsUploading(false);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(',')}
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        disabled={disabled || isUploading}
      />
      <Button
        variant="outlined"
        size="small"
        startIcon={isUploading ? <CircularProgress size={16} /> : <UploadIcon />}
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || isUploading}
      >
        {isUploading ? 'Uploading...' : 'Upload Custom Image'}
      </Button>
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}
