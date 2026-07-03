import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  CircularProgress,
  Alert,
  Stack,
} from '@mui/material';
import { EditLocationAlt as EditLocationAltIcon } from '@mui/icons-material';
import { LocationSearchPicker } from '../../components/media/LocationSearchPicker';
import { acceptLocationSuggestion } from '../../services/locationSuggestions';
import type { LocationSuggestionSummary } from '../../services/locationSuggestions';

interface AdjustLocationDialogProps {
  open: boolean;
  suggestion: LocationSuggestionSummary;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export function AdjustLocationDialog({ open, suggestion, onClose, onSuccess }: AdjustLocationDialogProps) {
  const [pinLocation, setPinLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the pin at the suggested coordinates whenever the dialog opens.
  useEffect(() => {
    if (!open) {
      setPinLocation(null);
      setMapCenter(null);
      setError(null);
      return;
    }
    setPinLocation({ lat: suggestion.lat, lng: suggestion.lng });
    setMapCenter([suggestion.lat, suggestion.lng]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestion.id]);

  const handlePinChange = useCallback((latlng: { lat: number; lng: number }) => {
    setPinLocation(latlng);
  }, []);

  const handleApply = useCallback(async () => {
    if (!pinLocation) return;
    setSaving(true);
    setError(null);
    try {
      const adjusted = pinLocation.lat !== suggestion.lat || pinLocation.lng !== suggestion.lng;
      await acceptLocationSuggestion(suggestion.id, pinLocation.lat, pinLocation.lng);
      onSuccess(adjusted ? 'Location confirmed with your adjustment' : 'Location confirmed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm location');
    } finally {
      setSaving(false);
    }
  }, [pinLocation, suggestion.id, suggestion.lat, suggestion.lng, onSuccess]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
          <EditLocationAltIcon />
          <span>Adjust suggested location</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Drag the pin, click the map, or search for a place. Moving the pin marks the location as manually
          adjusted; leaving it unchanged confirms the inferred coordinates.
        </Typography>

        {open && (
          <LocationSearchPicker
            value={pinLocation}
            onChange={handlePinChange}
            center={mapCenter ?? undefined}
            disabled={saving}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleApply()}
          disabled={!pinLocation || saving}
          startIcon={saving ? <CircularProgress size={14} /> : undefined}
        >
          Confirm location
        </Button>
      </DialogActions>
    </Dialog>
  );
}
