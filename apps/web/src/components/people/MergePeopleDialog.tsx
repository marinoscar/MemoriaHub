import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Alert,
  Autocomplete,
  TextField,
  CircularProgress,
} from '@mui/material';
import type { PersonListItem } from '../../services/face';

interface MergePeopleDialogProps {
  open: boolean;
  onClose: () => void;
  sourcePerson: PersonListItem;
  people: PersonListItem[];
  onMerge: (targetId: string) => Promise<void>;
}

export function MergePeopleDialog({
  open,
  onClose,
  sourcePerson,
  people,
  onMerge,
}: MergePeopleDialogProps) {
  const [targetPerson, setTargetPerson] = useState<PersonListItem | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Exclude the source person from the target list
  const options = people.filter((p) => p.id !== sourcePerson.id);

  const sourceLabel = sourcePerson.name ?? 'Unlabeled';
  const targetLabel = targetPerson?.name ?? 'Unlabeled';

  const handleMerge = async () => {
    if (!targetPerson) return;
    setMerging(true);
    setError(null);
    try {
      await onMerge(targetPerson.id);
      setTargetPerson(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed. Please try again.');
    } finally {
      setMerging(false);
    }
  };

  const handleClose = () => {
    if (merging) return;
    setTargetPerson(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Merge Person</DialogTitle>

      <DialogContent>
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            All photos assigned to <strong>{sourceLabel}</strong> ({sourcePerson.faceCount} faces)
            will be moved to the selected person. <strong>{sourceLabel}</strong> will then be
            removed.
          </Typography>

          <Autocomplete<PersonListItem>
            options={options}
            value={targetPerson}
            onChange={(_, value) => setTargetPerson(value)}
            getOptionLabel={(option) => option.name ?? 'Unlabeled'}
            renderOption={(props, option) => (
              <Box component="li" {...props} key={option.id}>
                <Box>
                  <Typography variant="body2">{option.name ?? 'Unlabeled'}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {option.faceCount} {option.faceCount === 1 ? 'face' : 'faces'}
                  </Typography>
                </Box>
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Merge into"
                placeholder="Select a person"
                size="small"
              />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
        </Box>

        {targetPerson && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            <strong>{sourceLabel}</strong> ({sourcePerson.faceCount} faces) will be merged into{' '}
            <strong>{targetLabel}</strong> ({targetPerson.faceCount} faces). This cannot be undone.
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} disabled={merging}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={() => void handleMerge()}
          disabled={!targetPerson || merging}
          startIcon={merging ? <CircularProgress size={16} /> : undefined}
        >
          {merging ? 'Merging…' : 'Merge'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
