import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  RadioGroup,
  FormControlLabel,
  Radio,
  Typography,
  Box,
} from '@mui/material';
import { listAlbums, addAlbumItems, addAlbumItemsByFilter } from '../../services/media';
import type { Album, AddAlbumItemsByFilterDto } from '../../types/media';
import { CreateAlbumDialog } from './CreateAlbumDialog';

interface AddToAlbumDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  selectedIds: string[];
  filters: AddAlbumItemsByFilterDto;
  matchingCount: number;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function AddToAlbumDialog({
  open,
  onClose,
  circleId,
  selectedIds,
  filters,
  matchingCount,
  onSuccess,
  onError,
}: AddToAlbumDialogProps) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState('');
  const [mode, setMode] = useState<'selected' | 'all'>('selected');
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedAlbumId('');
    setMode(selectedIds.length > 0 ? 'selected' : 'all');
    setLoadingAlbums(true);
    listAlbums({ circleId, pageSize: 100, sortBy: 'name', sortOrder: 'asc' })
      .then((resp) => setAlbums(resp.items))
      .catch(() => setAlbums([]))
      .finally(() => setLoadingAlbums(false));
  }, [open, circleId, selectedIds.length]);

  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId);

  const handleSubmit = async () => {
    if (!selectedAlbumId) return;
    setSaving(true);
    try {
      if (mode === 'selected' && selectedIds.length > 0) {
        await addAlbumItems(selectedAlbumId, selectedIds);
        onSuccess(
          `Added ${selectedIds.length} item${selectedIds.length !== 1 ? 's' : ''} to ${selectedAlbum?.name ?? 'album'}`,
        );
      } else {
        const result = await addAlbumItemsByFilter(selectedAlbumId, filters);
        onSuccess(
          `Added ${result.added} item${result.added !== 1 ? 's' : ''} to ${selectedAlbum?.name ?? 'album'}`,
        );
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add items to album');
    } finally {
      setSaving(false);
    }
  };

  const handleAlbumPickerChange = (value: string) => {
    if (value === '__new__') {
      setCreateOpen(true);
    } else {
      setSelectedAlbumId(value);
    }
  };

  const handleCreated = (album: Album) => {
    setAlbums((prev) => [...prev, album].sort((a, b) => a.name.localeCompare(b.name)));
    setSelectedAlbumId(album.id);
    setCreateOpen(false);
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Add to Album</DialogTitle>
        <DialogContent>
          <FormControl fullWidth size="small" sx={{ mt: 1, mb: 2 }}>
            <InputLabel>Album</InputLabel>
            <Select
              label="Album"
              value={selectedAlbumId}
              onChange={(e) => handleAlbumPickerChange(e.target.value)}
              disabled={loadingAlbums || saving}
            >
              {albums.map((album) => (
                <MenuItem key={album.id} value={album.id}>
                  {album.name}
                </MenuItem>
              ))}
              <MenuItem value="__new__">
                <em>+ Create new album...</em>
              </MenuItem>
            </Select>
          </FormControl>

          {selectedIds.length > 0 && (
            <Box sx={{ mb: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                What to add:
              </Typography>
              <RadioGroup
                value={mode}
                onChange={(_, val) => setMode(val as 'selected' | 'all')}
              >
                <FormControlLabel
                  value="selected"
                  control={<Radio size="small" />}
                  label={`Add ${selectedIds.length} selected item${selectedIds.length !== 1 ? 's' : ''}`}
                />
                <FormControlLabel
                  value="all"
                  control={<Radio size="small" />}
                  label={`Add all ${matchingCount} items matching current filters`}
                />
              </RadioGroup>
            </Box>
          )}

          {selectedIds.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Add all {matchingCount} items matching current filters.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSubmit()}
            disabled={!selectedAlbumId || saving || loadingAlbums}
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
          >
            {saving ? 'Adding...' : 'Add to Album'}
          </Button>
        </DialogActions>
      </Dialog>

      <CreateAlbumDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        circleId={circleId}
        onCreated={handleCreated}
      />
    </>
  );
}
