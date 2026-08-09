import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

interface DeleteMemoryDialogProps {
  open: boolean;
  memoryTitle: string;
  deleting?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Offered as the reversible alternative; omit where hide is not available. */
  onHideInstead?: () => void;
}

/**
 * Confirm dialog for the CIRCLE-LEVEL memory tombstone.
 *
 * The permanence has to be stated, not implied. `DELETE /api/memories/:id`
 * writes a tombstone whose natural key the curator checks on every future run,
 * so the memory is not "deleted until it regenerates" — it can never come back,
 * and it disappears for every other member of the circle at the same time.
 *
 * Per-user hide is the softer action and is offered right here as an escape
 * hatch, because "I don't want to see this" is the far more common intent and a
 * user who reaches this dialog by that route should not have to guess that a
 * reversible option exists elsewhere in the menu.
 */
export function DeleteMemoryDialog({
  open,
  memoryTitle,
  deleting = false,
  onClose,
  onConfirm,
  onHideInstead,
}: DeleteMemoryDialogProps) {
  return (
    <Dialog open={open} onClose={deleting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Delete this memory for everyone?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          “{memoryTitle}” will be removed for everyone in the circle. It won’t be
          created again.
        </DialogContentText>
        <Alert severity="warning" sx={{ mb: onHideInstead ? 2 : 0 }}>
          This can’t be undone. Your photos and videos are not deleted — only
          this curated collection of them.
        </Alert>
        {onHideInstead && (
          <DialogContentText variant="body2">
            Want it gone just for you? Hide it instead — that’s reversible and
            nobody else is affected.
          </DialogContentText>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        {onHideInstead && (
          <Button onClick={onHideInstead} disabled={deleting}>
            Hide for me
          </Button>
        )}
        <Button color="error" variant="contained" onClick={onConfirm} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete for everyone'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
