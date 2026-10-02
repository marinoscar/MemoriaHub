/**
 * Confirm unpairing a phone (issue #515). Unpairing revokes the device and
 * the access token it syncs with; media already uploaded stays. The API does
 * it — this dialog only asks.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import { mediaSyncErrorMessage, unpairDevice, type MediaSyncDevice } from '../../../services/mediaSync';

export const UNPAIR_EXPLANATION = 'The phone stops syncing; already uploaded media stays.';

interface UnpairDialogProps {
  device: MediaSyncDevice | null;
  onClose: () => void;
  onUnpaired: (device: MediaSyncDevice) => void;
}

export function UnpairDialog({ device, onClose, onUnpaired }: UnpairDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (device) setError(null);
  }, [device]);

  const confirm = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      await unpairDevice(device.id);
      onUnpaired(device);
    } catch (err) {
      setError(mediaSyncErrorMessage(err, 'Failed to unpair the phone'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={device !== null} onClose={busy ? undefined : onClose} aria-labelledby="unpair-title">
      <DialogTitle id="unpair-title">Unpair {device?.name}?</DialogTitle>
      <DialogContent>
        <DialogContentText>{UNPAIR_EXPLANATION}</DialogContentText>
        <DialogContentText sx={{ mt: 1 }}>
          Its access token is revoked. To sync again, pair it from the app.
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button color="error" variant="contained" onClick={() => void confirm()} disabled={busy}>
          Unpair
        </Button>
      </DialogActions>
    </Dialog>
  );
}
