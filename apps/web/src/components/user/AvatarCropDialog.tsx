import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Slider,
  Stack,
  Typography,
} from '@mui/material';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';

/** Edge length of the square JPEG produced by the crop. */
const OUTPUT_SIZE = 512;
const JPEG_QUALITY = 0.92;

/**
 * Render the chosen crop rectangle into a square JPEG blob.
 *
 * `croppedAreaPixels` from react-easy-crop is in SOURCE-image pixel space, so
 * drawing it straight into a fixed-size canvas both crops and normalizes the
 * output — a 12 MP phone photo and a 200 px thumbnail both leave here as the
 * same 512×512 JPEG, which is what keeps the upload inside the API's 5 MB cap.
 */
async function renderCroppedBlob(imageSrc: string, area: Area): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => reject(new Error('Could not read that image')));
    img.src = imageSrc;
  });

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the image for upload');

  ctx.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE,
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not prepare the image for upload'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

interface AvatarCropDialogProps {
  open: boolean;
  /** Object URL of the file the user picked; null while none is selected. */
  imageSrc: string | null;
  onCancel: () => void;
  onConfirm: (blob: Blob) => Promise<void>;
}

/**
 * Square-crop step between picking a file and uploading it.
 *
 * Mirrors the `SetProfilePictureDialog` crop step in PeoplePage (same library,
 * same `aspect={1}` + zoom-slider shape); the difference is that this one owns
 * the pixel-space crop, because the avatar endpoint takes BYTES rather than a
 * normalized crop rectangle stored alongside a media item.
 */
export function AvatarCropDialog({
  open,
  imageSrc,
  onCancel,
  onConfirm,
}: AvatarCropDialogProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per selected image so a second attempt never inherits the first crop.
  useEffect(() => {
    if (!open) return;
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    setError(null);
  }, [open, imageSrc]);

  const handleCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleConfirm = async () => {
    if (!imageSrc || !croppedAreaPixels) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await renderCroppedBlob(imageSrc, croppedAreaPixels);
      await onConfirm(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Crop your picture</DialogTitle>
      <DialogContent>
        {imageSrc ? (
          <Box sx={{ position: 'relative', height: 320, width: '100%', bgcolor: 'common.black' }}>
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          </Box>
        ) : (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        <Stack spacing={1} sx={{ mt: 2 }}>
          <Typography variant="body2" color="text.secondary" id="avatar-zoom-label">
            Zoom
          </Typography>
          <Slider
            value={zoom}
            min={1}
            max={4}
            step={0.05}
            onChange={(_e, value) => setZoom(value as number)}
            aria-labelledby="avatar-zoom-label"
            disabled={saving || !imageSrc}
          />
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleConfirm()}
          disabled={saving || !imageSrc || !croppedAreaPixels}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          {saving ? 'Uploading…' : 'Save picture'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
