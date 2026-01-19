import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Alert,
  CircularProgress,
} from '@mui/material';
import type { LibraryDTO, LibraryVisibility } from '@memoriahub/shared';
import { libraryApi } from '../../services/api';

interface CreateLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (library: LibraryDTO) => void;
}

/**
 * Dialog for creating a new library
 */
export function CreateLibraryDialog({ open, onClose, onCreated }: CreateLibraryDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<LibraryVisibility>('private');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (!isLoading) {
      setName('');
      setDescription('');
      setVisibility('private');
      setError(null);
      onClose();
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Library name is required');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const library = await libraryApi.createLibrary({
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
      });

      setName('');
      setDescription('');
      setVisibility('private');
      onCreated(library);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create library');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create Library</DialogTitle>

      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <TextField
            label="Library Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            required
            disabled={isLoading}
            placeholder="e.g., Family Photos, Vacation 2024"
            autoFocus
          />

          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            rows={2}
            disabled={isLoading}
            placeholder="Optional description for this library"
          />

          <FormControl fullWidth disabled={isLoading}>
            <InputLabel id="visibility-label">Visibility</InputLabel>
            <Select
              labelId="visibility-label"
              value={visibility}
              label="Visibility"
              onChange={(e) => setVisibility(e.target.value as LibraryVisibility)}
            >
              <MenuItem value="private">
                Private - Only you can see this library
              </MenuItem>
              <MenuItem value="shared">
                Shared - Only members you invite can see this library
              </MenuItem>
              <MenuItem value="public">
                Public - Anyone with the link can see this library
              </MenuItem>
            </Select>
          </FormControl>
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleCreate()}
          variant="contained"
          disabled={isLoading || !name.trim()}
          startIcon={isLoading ? <CircularProgress size={16} /> : undefined}
        >
          {isLoading ? 'Creating...' : 'Create Library'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
