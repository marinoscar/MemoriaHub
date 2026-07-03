import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  CircularProgress,
  Alert,
  Stack,
  Autocomplete,
  InputAdornment,
} from '@mui/material';
import { EditLocationAlt as EditLocationAltIcon, Search as SearchIcon } from '@mui/icons-material';
import { LocationPickerMap } from '../../components/media/LocationPickerMap';
import { searchPlaces, reverseGeocode } from '../../services/media';
import { acceptLocationSuggestion } from '../../services/locationSuggestions';
import type { GeoSearchResult, GeoReverseResult } from '../../types/media';
import type { LocationSuggestionSummary } from '../../services/locationSuggestions';
import { ApiError } from '../../services/api';

interface AdjustLocationDialogProps {
  open: boolean;
  suggestion: LocationSuggestionSummary;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export function AdjustLocationDialog({ open, suggestion, onClose, onSuccess }: AdjustLocationDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState<GeoSearchResult[]>([]);
  const [autocompleteValue, setAutocompleteValue] = useState<GeoSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDisabled, setSearchDisabled] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [pinLocation, setPinLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [geoPreview, setGeoPreview] = useState<GeoReverseResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the pin at the suggested coordinates whenever the dialog opens.
  useEffect(() => {
    if (!open) {
      setInputValue('');
      setOptions([]);
      setAutocompleteValue(null);
      setPinLocation(null);
      setMapCenter(null);
      setGeoPreview(null);
      setError(null);
      setSearchError(null);
      setSearchDisabled(false);
      return;
    }
    setPinLocation({ lat: suggestion.lat, lng: suggestion.lng });
    setMapCenter([suggestion.lat, suggestion.lng]);
    setGeoLoading(true);
    reverseGeocode(suggestion.lat, suggestion.lng)
      .then((result) => setGeoPreview(result))
      .catch(() => setGeoPreview(null))
      .finally(() => setGeoLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestion.id]);

  const handleInputChange = useCallback(
    (_event: React.SyntheticEvent, value: string) => {
      setInputValue(value);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      if (!value.trim() || value.trim().length < 2 || searchDisabled) {
        setOptions([]);
        return;
      }
      searchDebounceRef.current = setTimeout(() => {
        setSearchLoading(true);
        searchPlaces(value, 8)
          .then((results) => setOptions(results))
          .catch((err) => {
            if (err instanceof ApiError && err.status === 503) {
              setSearchDisabled(true);
              setOptions([]);
            } else {
              setSearchError('Search failed');
            }
          })
          .finally(() => setSearchLoading(false));
      }, 400);
    },
    [searchDisabled],
  );

  const handleSelectResult = useCallback((result: GeoSearchResult) => {
    setPinLocation({ lat: result.lat, lng: result.lng });
    setMapCenter([result.lat, result.lng]);
  }, []);

  const handleAutocompleteChange = useCallback(
    (_event: React.SyntheticEvent, selected: GeoSearchResult | null) => {
      setAutocompleteValue(selected);
      if (selected) handleSelectResult(selected);
    },
    [handleSelectResult],
  );

  const handlePinChange = useCallback((latlng: { lat: number; lng: number }) => {
    setPinLocation(latlng);
    setGeoLoading(true);
    reverseGeocode(latlng.lat, latlng.lng)
      .then((result) => setGeoPreview(result))
      .catch(() => setGeoPreview(null))
      .finally(() => setGeoLoading(false));
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

  const geoLabel = geoPreview
    ? [geoPreview.locality, geoPreview.admin1, geoPreview.country].filter(Boolean).join(', ')
    : null;

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

        {!searchDisabled ? (
          <Box sx={{ mb: 2 }}>
            <Autocomplete<GeoSearchResult, false, false, false>
              options={options}
              value={autocompleteValue}
              inputValue={inputValue}
              loading={searchLoading}
              filterOptions={(x) => x}
              getOptionLabel={(opt) => opt.label}
              isOptionEqualToValue={(opt, val) => opt.label === val.label && opt.lat === val.lat}
              onInputChange={handleInputChange}
              onChange={handleAutocompleteChange}
              noOptionsText="No results found"
              loadingText="Searching..."
              disabled={saving}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Search place"
                  size="small"
                  error={!!searchError}
                  helperText={searchError ?? undefined}
                  slotProps={{
                    ...params.slotProps,
                    input: {
                      ...params.slotProps.input,
                      startAdornment: (
                        <InputAdornment position="start">
                          {searchLoading ? (
                            <CircularProgress size={16} />
                          ) : (
                            <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                          )}
                        </InputAdornment>
                      ),
                    },
                  }}
                />
              )}
            />
          </Box>
        ) : (
          <Alert severity="info" sx={{ mb: 2 }}>
            Place search unavailable — drop a pin on the map.
          </Alert>
        )}

        <LocationPickerMap value={pinLocation} onChange={handlePinChange} height={280} center={mapCenter ?? undefined} />

        {(geoLoading || geoLabel || pinLocation) && (
          <Box sx={{ mt: 1.5, p: 1.5, backgroundColor: 'action.hover', borderRadius: 1 }}>
            {geoLoading ? (
              <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
                <CircularProgress size={14} />
                <Typography variant="caption">Looking up location...</Typography>
              </Stack>
            ) : pinLocation ? (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Pin: {pinLocation.lat.toFixed(5)}, {pinLocation.lng.toFixed(5)}
                </Typography>
                {geoLabel && <Typography variant="body2" sx={{ fontWeight: 500 }}>{geoLabel}</Typography>}
              </>
            ) : null}
          </Box>
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
