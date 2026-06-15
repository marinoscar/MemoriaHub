/**
 * LocationPickerMap — an interactive Leaflet map for picking a single coordinate.
 * Click anywhere on the map to place/move a draggable marker.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultIcon } from '../../lib/leaflet-setup';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';
import { Box, IconButton } from '@mui/material';
import MyLocationIcon from '@mui/icons-material/MyLocation';

interface LocationPickerMapProps {
  value: { lat: number; lng: number } | null;
  onChange: (latlng: { lat: number; lng: number }) => void;
  height?: number;
  center?: [number, number];
}

// Inner component that handles map events (must be inside MapContainer)
function ClickHandler({ onChange }: { onChange: (latlng: { lat: number; lng: number }) => void }) {
  useMapEvents({
    click(e: LeafletMouseEvent) {
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
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

function useGeoLocation() {
  const [geoCenter, setGeoCenter] = useState<[number, number] | null>(null);
  const [geoPending, setGeoPending] = useState(false);
  const requestedRef = useRef(false);

  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    setGeoPending(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoCenter([pos.coords.latitude, pos.coords.longitude]);
        setGeoPending(false);
      },
      () => {
        // denied or error — leave geoCenter null
        setGeoPending(false);
      },
      { timeout: 8000 },
    );
  }, []);

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    requestLocation();
  }, [requestLocation]);

  return { geoCenter, geoPending, requestLocation };
}

export function LocationPickerMap({
  value,
  onChange,
  height = 300,
  center,
}: LocationPickerMapProps) {
  const { geoCenter, requestLocation } = useGeoLocation();

  const defaultCenter: [number, number] = value
    ? [value.lat, value.lng]
    : center ?? [20, 0];
  const defaultZoom = value ? 13 : 2;

  const handleDrag = useCallback(
    (e: { target: { getLatLng: () => { lat: number; lng: number } } }) => {
      const latlng = e.target.getLatLng();
      onChange({ lat: latlng.lat, lng: latlng.lng });
    },
    [onChange],
  );

  return (
    <Box sx={{ position: 'relative' }}>
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        scrollWheelZoom={false}
        style={{ height, width: '100%', borderRadius: 8, cursor: 'crosshair' }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <ClickHandler onChange={onChange} />
        {center && <MapRecenterer center={center} />}
        {!value && !center && geoCenter && <MapRecenterer center={geoCenter} />}
        {value && (
          <Marker
            position={[value.lat, value.lng]}
            icon={defaultIcon}
            draggable
            eventHandlers={{ dragend: handleDrag }}
          />
        )}
      </MapContainer>
      {typeof navigator !== 'undefined' && 'geolocation' in navigator && (
        <IconButton
          onClick={requestLocation}
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
    </Box>
  );
}
