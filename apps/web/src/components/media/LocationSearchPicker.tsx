/**
 * LocationSearchPicker — a self-contained location picker that bundles:
 *   1. A debounced place-search Autocomplete (with a graceful 503 fallback).
 *   2. An interactive LocationPickerMap for dropping/dragging a pin.
 *   3. A reverse-geocode CONFIRM ROW for the currently selected coordinate.
 *
 * It is a controlled component: the parent owns the `value` coordinate and is
 * notified of changes through `onChange`. All search + confirm state is internal.
 *
 * The confirm row is a PRESENTATION layer over the reverse-geocode state that
 * already existed here (same single lookup, same `lastGeocodedRef` guard): it
 * promotes what used to be a faint caption into a bordered row that names the
 * address being committed, with an explicit resolving state and an explicit
 * "no address found" fallback so a coordinate-only pin never looks broken.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Stack,
  Autocomplete,
  InputAdornment,
  TextField,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import PlaceIcon from '@mui/icons-material/Place';
import { LocationPickerMap } from './LocationPickerMap';
import { searchPlaces, reverseGeocode } from '../../services/media';
import type { GeoSearchResult, GeoReverseResult } from '../../types/media';
import { ApiError } from '../../services/api';

interface LocationSearchPickerProps {
  value: { lat: number; lng: number } | null;
  onChange: (loc: { lat: number; lng: number }) => void;
  center?: [number, number]; // recenters map when a search result is picked
  height?: number; // map height, default 280
  disabled?: boolean; // disables the autocomplete during save
  showPreview?: boolean; // reverse-geocode confirm row, default true
  /**
   * Where the map should OPEN when `value` is null (the caller's best guess:
   * the item's own coords, an inferred candidate, …). Framing hint only.
   */
  initialCenter?: { lat: number; lng: number };
  /** Mouse-wheel zoom on the map. Default true for this picker. */
  scrollWheelZoom?: boolean;
  /** Explicit "Use my location" also sets the coordinate. Default true. */
  geolocateSetsValue?: boolean;
  /** Muted draggable pin at the map centre while no coordinate is set. Default true. */
  showPlaceholderMarker?: boolean;
}

export function LocationSearchPicker({
  value,
  onChange,
  center,
  height = 280,
  disabled = false,
  showPreview = true,
  initialCenter,
  scrollWheelZoom = true,
  geolocateSetsValue = true,
  showPlaceholderMarker = true,
}: LocationSearchPickerProps) {
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState<GeoSearchResult[]>([]);
  const [autocompleteValue, setAutocompleteValue] = useState<GeoSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDisabled, setSearchDisabled] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Internal map center seeded from the `center` prop; kept in sync below and
  // also updated when a search result is chosen so the map recenters on it.
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(center ?? null);

  const [geoPreview, setGeoPreview] = useState<GeoReverseResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the coordinate we last reverse-geocoded so identity-only re-renders
  // (same lat/lng) don't trigger redundant lookups.
  const lastGeocodedRef = useRef<string | null>(null);

  // Keep the internal map center in sync when the parent `center` prop changes.
  useEffect(() => {
    if (center) setMapCenter(center);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1]]);

  // Clear the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Reverse-geocode the current pin for the preview box. Runs whenever `value`
  // changes (map pin move, search select, or external seeding by the parent),
  // guarded against redundant lookups for the same coordinate.
  useEffect(() => {
    if (!showPreview) return;
    if (!value) {
      setGeoPreview(null);
      setGeoLoading(false);
      lastGeocodedRef.current = null;
      return;
    }
    const key = `${value.lat},${value.lng}`;
    if (lastGeocodedRef.current === key) return;
    lastGeocodedRef.current = key;

    let cancelled = false;
    setGeoLoading(true);
    reverseGeocode(value.lat, value.lng)
      .then((result) => {
        if (!cancelled) setGeoPreview(result);
      })
      .catch(() => {
        if (!cancelled) setGeoPreview(null);
      })
      .finally(() => {
        if (!cancelled) setGeoLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [value?.lat, value?.lng, showPreview]);

  // Debounced place search — called by Autocomplete's onInputChange
  const handleInputChange = useCallback(
    (_event: React.SyntheticEvent, val: string) => {
      setInputValue(val);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      if (!val.trim() || val.trim().length < 2 || searchDisabled) {
        setOptions([]);
        return;
      }
      searchDebounceRef.current = setTimeout(() => {
        setSearchLoading(true);
        searchPlaces(val, 8)
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
    },
    [searchDisabled],
  );

  // When a search result is selected, recenter map + set pin
  const handleAutocompleteChange = useCallback(
    (_event: React.SyntheticEvent, selected: GeoSearchResult | null) => {
      setAutocompleteValue(selected);
      if (selected) {
        onChange({ lat: selected.lat, lng: selected.lng });
        setMapCenter([selected.lat, selected.lng]);
      }
    },
    [onChange],
  );

  const geoLabel = geoPreview
    ? [geoPreview.locality, geoPreview.admin1, geoPreview.country].filter(Boolean).join(', ')
    : null;

  return (
    <Box>
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
            disabled={disabled}
            slotProps={{
              popper: {
                sx: { zIndex: (theme) => theme.zIndex.modal + 2 },
              },
            }}
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

      {/* Map */}
      <LocationPickerMap
        value={value}
        onChange={onChange}
        height={height}
        center={mapCenter ?? undefined}
        initialCenter={initialCenter}
        scrollWheelZoom={scrollWheelZoom}
        geolocateSetsValue={geolocateSetsValue}
        showPlaceholderMarker={showPlaceholderMarker}
      />

      {/* Confirm row — names the address about to be committed. */}
      {showPreview && (geoLoading || value) && (
        <Box
          data-testid="location-confirm-row"
          sx={{
            mt: 1.5,
            p: 1.5,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            backgroundColor: 'action.hover',
            maxWidth: '100%',
            overflow: 'hidden',
          }}
        >
          {geoLoading ? (
            <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">
                Finding address…
              </Typography>
            </Stack>
          ) : (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', minWidth: 0 }}>
              <PlaceIcon fontSize="small" color="primary" sx={{ mt: '2px', flexShrink: 0 }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}
                >
                  {geoLabel
                    ? `Use this location: ${geoLabel}`
                    : 'Coordinates only — no address found'}
                </Typography>
                {value && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', overflowWrap: 'anywhere' }}
                  >
                    {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
                  </Typography>
                )}
              </Box>
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
}
