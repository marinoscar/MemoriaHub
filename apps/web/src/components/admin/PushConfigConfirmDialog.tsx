/**
 * The rotate / remove confirmation dialog for Web Push (VAPID) config.
 * Epic #481, issue #487.
 *
 * ONE COMPONENT FOR BOTH INTENTS, mirroring `DbBackupRestoreDialog`: rotate and
 * remove need exactly the same safety machinery — a stated consequence and a
 * TYPED CONFIRMATION LITERAL — and differ only in copy and which literal they
 * require.
 *
 * THE TWO LITERALS ARE DIFFERENT WORDS ON PURPOSE (`ROTATE` / `REMOVE`). The
 * typed text is cleared every time the dialog opens or `action` changes, so a
 * value typed for Rotate can never be reused to confirm Remove.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';
import { REMOVE_CONFIRMATION, ROTATE_CONFIRMATION } from '../../services/pushConfig';

export type PushConfigDialogAction = 'rotate' | 'remove';

export interface PushConfigConfirmDialogProps {
  /** `null` closes the dialog; a specific action opens it in that mode. */
  action: PushConfigDialogAction | null;
  isWorking: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const COPY: Record<
  PushConfigDialogAction,
  { title: string; consequence: string; confirmLabel: string }
> = {
  rotate: {
    title: 'Rotate the VAPID key pair?',
    consequence:
      'Rotating replaces the key pair. Every existing push subscription stops receiving ' +
      'notifications immediately. A browser only recovers once it re-subscribes against ' +
      'the new key — which happens the next time that user opens the app with ' +
      'notifications allowed. Devices that are never reopened stay silent.',
    confirmLabel: 'Rotate keys',
  },
  remove: {
    title: 'Remove the web push configuration?',
    consequence:
      'Removing deletes the stored key pair entirely and switches web push off. Every ' +
      'existing push subscription stops receiving notifications, and none can recover ' +
      'until a new key pair is generated. In-app notifications keep working; only web ' +
      'push stops.',
    confirmLabel: 'Remove configuration',
  },
};

export function PushConfigConfirmDialog({
  action,
  isWorking,
  error,
  onConfirm,
  onClose,
}: PushConfigConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!action) return;
    setTyped('');
  }, [action]);

  if (!action) return null;

  const literal = action === 'rotate' ? ROTATE_CONFIRMATION : REMOVE_CONFIRMATION;
  const copy = COPY[action];
  const typedMatches = typed.trim() === literal;

  return (
    <Dialog open onClose={isWorking ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{copy.title}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Alert severity="warning">
          <AlertTitle>This cannot be undone</AlertTitle>
          {copy.consequence}
        </Alert>

        <Box sx={{ mt: 3 }}>
          <TextField
            fullWidth
            label={`Type ${literal} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            helperText="This must be typed exactly, in capitals. Nothing happens until it matches."
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isWorking}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={!typedMatches || isWorking}
          onClick={onConfirm}
        >
          {isWorking ? 'Working…' : copy.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
