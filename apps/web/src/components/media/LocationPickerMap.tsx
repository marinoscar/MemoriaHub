/**
 * LocationPickerMap — an interactive Leaflet map for picking a single coordinate.
 *
 * Three ways to set the coordinate:
 *   1. Click anywhere on the map.
 *   2. Drag the pin. When no coordinate is set yet a MUTED PLACEHOLDER pin is
 *      rendered at the map centre (kept pinned to the centre as the map moves)
 *      so there is always something grabbable — previously a null `value`
 *      rendered no marker at all and the click affordance was undiscoverable.
 *      Suppressible via `showPlaceholderMarker`.
 *   3. Press "Use my location" (only when `geolocateSetsValue` is true).
 *
 * Geolocation has TWO distinct paths, deliberately:
 *   - ON MOUNT: a silent, recenter-only probe. It must NEVER write a value —
 *     doing so would silently overwrite an existing coordinate.
 *   - EXPLICIT BUTTON PRESS: recenters AND (when `geolocateSetsValue`) reports
 *     the coordinate up through `onChange`, with MapControls-style error
 *     messaging in a snackbar.
 *
 * Backward compatibility: every prop added here is OPTIONAL and defaults to the
 * NEW behaviour, so the intended consumer (LocationSearchPicker) gets all of it
 * for free. The three non-picker call sites (SearchPanel, ActionParamEditor,
 * ConditionValueEditor) explicitly opt out of all three additions
 * (`geolocateSetsValue`, `scrollWheelZoom`, `showPlaceholderMarker`) so they
 * remain visually and behaviourally identical to before — an acceptance
 * criterion of issue #376.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultIcon } from '../../lib/leaflet-setup';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents, useMap } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';
import { Box, IconButton, Snackbar, Alert } from '@mui/material';
import MyLocationIcon from '@mui/icons-material/MyLocation';

export interface LatLngValue {
  lat: number;
  lng: number;
}

interface LocationPickerMapProps {
  value: LatLngValue | null;
  onChange: (latlng: LatLngValue) => void;
  height?: number;
  /** Recenters the map whenever this changes (e.g. a chosen search result). */
  center?: [number, number];
  /**
   * Where the map should OPEN when there is no `value` yet. Unlike `center`
   * this is an initial framing hint only — it does not force a later recenter.
   */
  initialCenter?: LatLngValue;
  /**
   * When true (default) an EXPLICIT "Use my location" press also sets the
   * coordinate via `onChange`, not just the map view. The on-mount auto-locate
   * is always recenter-only regardless of this flag.
   */
  geolocateSetsValue?: boolean;
  /** Mouse-wheel zoom. Default true — off for embedded/scrollable call sites. */
  scrollWheelZoom?: boolean;
  /**
   * Render the muted, draggable placeholder pin at the map centre while
   * `value` is null. Default true. Set false to restore the pre-#376 look,
   * where a null value renders no marker at all.
   */
  showPlaceholderMarker?: boolean;
  /**
   * Draw a translucent radius overlay around the current pin, in METRES
   * (Leaflet's `<Circle radius>` unit). Null/undefined — the default — renders
   * nothing at all, so every pre-existing call site is untouched. Used by the
   * Location Groups editor's Area block (issue #375), whose slider is bounded
   * by the loaded `locationGrouping.maxRadiusKm` setting.
   */
  radiusMeters?: number | null;
}

/** Opacity applied to the placeholder pin so it reads as "not set yet". */
const PLACEHOLDER_PIN_OPACITY = 0.55;

// Inner component that handles map events (must be inside MapContainer)
function ClickHandler({ onChange }: { onChange: (latlng: LatLngValue) => void }) {
  useMapEvents({
    click(e: LeafletMouseEvent) {
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

/**
 * Reports the map's live centre upward so the placeholder pin can stay pinned
 * to the middle of the viewport while no coordinate has been chosen.
 * Optional-chained throughout so a partially-stubbed react-leaflet (unit tests)
 * cannot throw.
 */
function CenterTracker({ onCenter }: { onCenter: (center: [number, number]) => void }) {
  const map = useMapEvents({
    move() {
      const c = map?.getCenter?.();
      if (c) onCenter([c.lat, c.lng]);
    },
  });
  return null;
}

// Recenters map when center prop changes
function MapRecenterer({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, Math.max(map.getZoom(), 12));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, center[0], center[1]]);
  return null;
}

interface GeoRequestHandlers {
  onLocated?: (coords: LatLngValue) => void;
  onError?: (message: string) => void;
}

function useGeoLocation() {
  const [geoCenter, setGeoCenter] = useState<[number, number] | null>(null);
  const [geoPending, setGeoPending] = useState(false);
  const requestedRef = useRef(false);

  const requestLocation = useCallback((handlers?: GeoRequestHandlers) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      handlers?.onError?.('Geolocation is not supported by your browser.');
      return;
    }
    setGeoPending(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGeoCenter([coords.lat, coords.lng]);
        setGeoPending(false);
        handlers?.onLocated?.(coords);
      },
      (err) => {
        setGeoPending(false);
        // Mirrors MapControls' permission-denied / generic-failure copy.
        const denied = err?.code === (err?.PERMISSION_DENIED ?? 1);
        handlers?.onError?.(
          denied ? 'Location permission denied.' : 'Could not determine your location.',
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }, []);

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    // Recenter-only, and silent: no onLocated (would overwrite an existing
    // coordinate) and no onError (the user did not ask for this).
    requestLocation();
  }, [requestLocation]);

  return { geoCenter, geoPending, requestLocation };
}

export function LocationPickerMap({
  value,
  onChange,
  height = 300,
  center,
  initialCenter,
  geolocateSetsValue = true,
  scrollWheelZoom = true,
  showPlaceholderMarker = true,
  radiusMeters = null,
}: LocationPickerMapProps) {
  const { geoCenter, requestLocation } = useGeoLocation();
  const [geoError, setGeoError] = useState<string | null>(null);

  const defaultCenter: [number, number] = value
    ? [value.lat, value.lng]
    : initialCenter
      ? [initialCenter.lat, initialCenter.lng]
      : center ?? [20, 0];
  const defaultZoom = value || initialCenter ? 13 : 2;

  // Live position of the placeholder pin shown while `value` is null. Seeded
  // from the initial view and then kept in sync with the map centre.
  const [placeholderPos, setPlaceholderPos] = useState<[number, number]>(() => defaultCenter);

  useEffect(() => {
    if (center) setPlaceholderPos(center);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1]]);

  useEffect(() => {
    if (geoCenter) setPlaceholderPos(geoCenter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoCenter?.[0], geoCenter?.[1]]);

  const handleDrag = useCallback(
    (e: { target: { getLatLng: () => LatLngValue } }) => {
      const latlng = e.target.getLatLng();
      onChange({ lat: latlng.lat, lng: latlng.lng });
    },
    [onChange],
  );

  const handleGeolocateClick = useCallback(() => {
    setGeoError(null);
    requestLocation({
      onLocated: (coords) => {
        if (geolocateSetsValue) onChange(coords);
      },
      onError: (message) => setGeoError(message),
    });
  }, [requestLocation, geolocateSetsValue, onChange]);

  return (
    <Box sx={{ position: 'relative', maxWidth: '100%', overflow: 'hidden' }}>
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        scrollWheelZoom={scrollWheelZoom}
        style={{ height, width: '100%', borderRadius: 8, cursor: 'crosshair' }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <ClickHandler onChange={onChange} />
        {center && <MapRecenterer center={center} />}
        {!value && !center && !initialCenter && geoCenter && <MapRecenterer center={geoCenter} />}
        {value && radiusMeters != null && radiusMeters > 0 && (
          <Circle
            center={[value.lat, value.lng]}
            radius={radiusMeters}
            pathOptions={{ color: '#1976d2', fillColor: '#1976d2', fillOpacity: 0.15 }}
          />
        )}
        {value ? (
          <Marker
            position={[value.lat, value.lng]}
            icon={defaultIcon}
            draggable
            eventHandlers={{ dragend: handleDrag }}
          />
        ) : showPlaceholderMarker ? (
          <>
            <CenterTracker onCenter={setPlaceholderPos} />
            <Marker
              position={placeholderPos}
              icon={defaultIcon}
              draggable
              opacity={PLACEHOLDER_PIN_OPACITY}
              eventHandlers={{ dragend: handleDrag }}
            />
          </>
        ) : null}
      </MapContainer>
      {typeof navigator !== 'undefined' && 'geolocation' in navigator && (
        <IconButton
          onClick={handleGeolocateClick}
          size="small"
          aria-label="Use my location"
          sx={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            zIndex: 1000,
            backgroundColor: 'background.paper',
            boxShadow: 2,
            '&:hover': { backgroundColor: 'action.hover' },
          }}
        >
          <MyLocationIcon fontSize="small" />
        </IconButton>
      )}
      <Snackbar
        open={!!geoError}
        autoHideDuration={5000}
        onClose={() => setGeoError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="warning" variant="filled" onClose={() => setGeoError(null)}>
          {geoError}
        </Alert>
      </Snackbar>
    </Box>
  );
}
