import { useState } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Tooltip,
  Stack,
  CircularProgress,
  Alert,
  Divider,
} from '@mui/material';
import {
  Close as CloseIcon,
  RotateLeft as RotateLeftIcon,
  RotateRight as RotateRightIcon,
  Flip as FlipIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { MediaItem } from '../../types/media';
import { editOrientation, type OrientationOp } from '../../services/media';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MediaOrientationEditorProps {
  item: MediaItem;
  open: boolean;
  onClose: () => void;
  /**
   * Called after a successful orientation edit so the parent can bust its
   * cached full item, refetch signed URLs, and force the preview to reload.
   */
  onEdited: (updated?: MediaItem) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Immich-style "Editor" side panel operating on a single photo. Orientation
 * only (no crop). Each button applies a destructive rotate/flip immediately
 * via POST /api/media/:id/edit/orientation (there is no separate Save step),
 * then signals the parent via onEdited so it can refresh the stale preview.
 */
export function MediaOrientationEditor({
  item,
  open,
  onClose,
  onEdited,
}: MediaOrientationEditorProps) {
  const theme = useTheme();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const runOp = async (op: OrientationOp) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await editOrientation(item.id, op);
      setSaved(true);
      onEdited();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply edit');
    } finally {
      setBusy(false);
    }
  };

  const orientationButtons: {
    op: OrientationOp;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { op: 'rotate_left', label: 'Rotate left', icon: <RotateLeftIcon /> },
    { op: 'rotate_right', label: 'Rotate right', icon: <RotateRightIcon /> },
    { op: 'flip_horizontal', label: 'Flip horizontal', icon: <FlipIcon /> },
    {
      op: 'flip_vertical',
      label: 'Flip vertical',
      icon: <FlipIcon sx={{ transform: 'rotate(90deg)' }} />,
    },
  ];

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      variant="temporary"
      // Render above the fullscreen lightbox Dialog (zIndex 1200).
      sx={{
        zIndex: (t: Theme) => t.zIndex.modal + 2,
        '& .MuiDrawer-paper': {
          width: 320,
          maxWidth: '100vw',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 2,
          py: 1,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <IconButton
          onClick={onClose}
          size="small"
          aria-label="Close editor"
          sx={{ minWidth: 44, minHeight: 44 }}
        >
          <CloseIcon />
        </IconButton>
        <Typography variant="h6" sx={{ ml: 1, flex: 1 }} noWrap>
          Editor
        </Typography>
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 2, py: 2 }}>
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', mb: 1 }}
        >
          Orientation
        </Typography>

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} useFlexGap>
          {orientationButtons.map(({ op, label, icon }) => (
            <Tooltip key={op} title={label}>
              {/* span wrapper keeps the Tooltip working while the button is disabled */}
              <span>
                <IconButton
                  aria-label={label}
                  onClick={() => void runOp(op)}
                  disabled={busy}
                  sx={{
                    minWidth: 44,
                    minHeight: 44,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 1.5,
                  }}
                >
                  {icon}
                </IconButton>
              </span>
            </Tooltip>
          ))}
        </Stack>

        {busy && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Applying…
            </Typography>
          </Box>
        )}

        {saved && !busy && (
          <Alert severity="success" sx={{ mt: 2 }} onClose={() => setSaved(false)}>
            Saved
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Divider sx={{ my: 2 }} />
        <Typography variant="caption" color="text.secondary">
          Rotations and flips are applied immediately to the original photo and
          cannot be undone from here.
        </Typography>
      </Box>
    </Drawer>
  );
}
