import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Alert,
  Typography,
} from '@mui/material';

interface BulkDeleteDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Number of selected items */
  selectedCount: number;
  /** Handler to close dialog */
  onClose: () => void;
  /** Handler to confirm deletion */
  onConfirm: () => void;
}

/**
 * Confirmation dialog for deleting multiple media items
 * Shows warning about permanent deletion
 */
export function BulkDeleteDialog({
  open,
  selectedCount,
  onClose,
  onConfirm,
}: BulkDeleteDialogProps) {
  const handleConfirm = () => {
    onConfirm();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete Media</DialogTitle>

      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Are you sure you want to delete {selectedCount} selected{' '}
          {selectedCount === 1 ? 'item' : 'items'}?
        </DialogContentText>

        <Alert severity="warning">
          <Typography variant="body2">
            This action cannot be undone. The media files will be permanently deleted from
            storage and removed from all libraries.
          </Typography>
        </Alert>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color="error" onClick={handleConfirm}>
          Delete {selectedCount} {selectedCount === 1 ? 'Item' : 'Items'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
