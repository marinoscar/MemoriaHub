import { Dialog, DialogTitle, DialogContent } from '@mui/material';
import type { Theme } from '@mui/material';
import type { ShareTargetType } from '../../types/sharing';
import { SharePanel } from './SharePanel';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  target: {
    type: ShareTargetType;
    id: string;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Thin Dialog wrapper around {@link SharePanel} for standalone (non-nested)
 * call sites such as the Albums page. When embedding the share UI inside
 * another Modal-based surface (e.g. a temporary Drawer), render `SharePanel`
 * inline instead of this component to avoid nested-modal focus-trap freezes.
 */
export function ShareDialog({ open, onClose, target }: ShareDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      sx={{ zIndex: (theme: Theme) => theme.zIndex.modal + 2 }}
    >
      <DialogTitle>Share publicly</DialogTitle>
      <DialogContent>
        <SharePanel target={target} onRequestClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
