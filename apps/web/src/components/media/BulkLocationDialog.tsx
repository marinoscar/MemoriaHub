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
import {
  LocationOn as LocationOnIcon,
  Search as SearchIcon,
  Clear as ClearIcon,
} from '@mui/icons-material';
import { LocationPickerMap } from './LocationPickerMap';
import { searchPlaces, reverseGeocode, bulkUpdateMedia } from '../../services/media';
import type { GeoSearchResult, GeoReverseResult } from '../../types/media';
import { ApiError } from '../../services/api';

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

  // Reset state when dialog opens/closes
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
    }
  }, [open]);

  // Debounced place search — called by Autocomplete's onInputChange
  const handleInputChange = useCallback((_event: React.SyntheticEvent, value: string) => {
    setInputValue(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!value.trim() || value.trim().length < 2 || searchDisabled) {
      setOptions([]);
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      setSearchLoading(true);
      searchPlaces(value, 8)
        .then((results) => {
          setOptions(results);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 503) {
            setSearchDisabled(true);
            setOptions([]);
          } else {
            setSearchError('Search failed');
          }
        })
        .finally(() => {
          setSearchLoading(false);
        });
    }, 400);
  }, [searchDisabled]);

  // When a search result is selected, recenter map + set pin
  const handleSelectResult = useCallback((result: GeoSearchResult) => {
    setPinLocation({ lat: result.lat, lng: result.lng });
    setMapCenter([result.lat, result.lng]);
  }, []);

  // Called by Autocomplete's onChange when the user selects an option
  const handleAutocompleteChange = useCallback(
    (_event: React.SyntheticEvent, selected: GeoSearchResult | null) => {
      setAutocompleteValue(selected);
      if (selected) {
        handleSelectResult(selected);
      }
    },
    [handleSelectResult],
  );

  // When pin changes, reverse geocode for preview
  const handlePinChange = useCallback((latlng: { lat: number; lng: number }) => {
    setPinLocation(latlng);
    setGeoLoading(true);
    reverseGeocode(latlng.lat, latlng.lng)
      .then((result) => {
        setGeoPreview(result);
      })
      .catch(() => {
        setGeoPreview(null);
      })
      .finally(() => {
        setGeoLoading(false);
      });
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

  const geoLabel = geoPreview
    ? [geoPreview.locality, geoPreview.admin1, geoPreview.country].filter(Boolean).join(', ')
    : null;

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

        {/* Place search */}
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
                    input: {
                      ...params.InputProps,
                      startAdornment: (
                        <InputAdornment position="start">
                          {searchLoading
                            ? <CircularProgress size={16} />
                            : <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                          }
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

        {/* Map */}
        <LocationPickerMap
          value={pinLocation}
          onChange={handlePinChange}
          height={280}
          center={mapCenter ?? undefined}
        />

        {/* Reverse geocode preview */}
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
                {geoLabel && (
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>{geoLabel}</Typography>
                )}
              </>
            ) : null}
          </Box>
        )}
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
