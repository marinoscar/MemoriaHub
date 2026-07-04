import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  CircularProgress,
  Alert,
  Stack,
} from '@mui/material';
import {
  LocationOn as LocationOnIcon,
  Clear as ClearIcon,
} from '@mui/icons-material';
import { LocationSearchPicker } from './LocationSearchPicker';
import { bulkUpdateMedia } from '../../services/media';

interface BulkLocationDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  ids: string[];
  onSuccess: (message: string) => void;
}

export function BulkLocationDialog({
  open,
  onClose,
  circleId,
  ids,
  onSuccess,
}: BulkLocationDialogProps) {
  const [pinLocation, setPinLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setPinLocation(null);
      setMapCenter(null);
      setError(null);
    }
  }, [open]);

  const handlePinChange = useCallback((latlng: { lat: number; lng: number }) => {
    setPinLocation(latlng);
  }, []);

  const handleApply = useCallback(async () => {
    if (!pinLocation) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bulkUpdateMedia({
        circleId,
        ids,
        set: { location: { lat: pinLocation.lat, lng: pinLocation.lng } },
      });
      onSuccess(`Location set for ${result.updated} item${result.updated !== 1 ? 's' : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set location');
    } finally {
      setSaving(false);
    }
  }, [circleId, ids, pinLocation, onSuccess]);

  const handleClearLocation = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await bulkUpdateMedia({
        circleId,
        ids,
        set: { location: null },
      });
      onSuccess(`Cleared location for ${result.updated} item${result.updated !== 1 ? 's' : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear location');
    } finally {
      setSaving(false);
    }
  }, [circleId, ids, onSuccess]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
          <LocationOnIcon />
          <span>Set Location for {ids.length} item{ids.length !== 1 ? 's' : ''}</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Box sx={{ mt: 1 }}>
          {open && (
            <LocationSearchPicker
              value={pinLocation}
              onChange={handlePinChange}
              center={mapCenter ?? undefined}
              disabled={saving}
            />
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
        <Button
          variant="text"
          color="error"
          startIcon={<ClearIcon />}
          onClick={() => void handleClearLocation()}
          disabled={saving}
        >
          Clear Location
        </Button>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void handleApply()}
            disabled={!pinLocation || saving}
            startIcon={saving ? <CircularProgress size={14} /> : undefined}
          >
            Apply
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
