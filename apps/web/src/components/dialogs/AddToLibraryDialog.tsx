import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  Alert,
} from '@mui/material';
import type { LibraryDTO } from '@memoriahub/shared';

interface AddToLibraryDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Number of selected items */
  selectedCount: number;
  /** Available libraries */
  libraries: LibraryDTO[];
  /** Handler to close dialog */
  onClose: () => void;
  /** Handler to add to library */
  onAdd: (libraryId: string) => void;
}

/**
 * Dialog for adding selected media to a library
 * Shows library selection dropdown
 */
export function AddToLibraryDialog({
  open,
  selectedCount,
  libraries,
  onClose,
  onAdd,
}: AddToLibraryDialogProps) {
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>('');

  const handleAdd = () => {
    if (selectedLibraryId) {
      onAdd(selectedLibraryId);
      handleClose();
    }
  };

  const handleClose = () => {
    setSelectedLibraryId('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add to Library</DialogTitle>

      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Add {selectedCount} selected items to a library
        </Typography>

        {libraries.length === 0 ? (
          <Alert severity="info">
            You don't have any libraries. Create a library first.
          </Alert>
        ) : (
          <FormControl fullWidth>
            <InputLabel id="library-select-label">Select Library</InputLabel>
            <Select
              labelId="library-select-label"
              id="library-select"
              value={selectedLibraryId}
              label="Select Library"
              onChange={(e) => setSelectedLibraryId(e.target.value)}
            >
              {libraries.map((library) => (
                <MenuItem key={library.id} value={library.id}>
                  {library.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleAdd}
          disabled={!selectedLibraryId || libraries.length === 0}
        >
          Add to Library
        </Button>
      </DialogActions>
    </Dialog>
  );
}
