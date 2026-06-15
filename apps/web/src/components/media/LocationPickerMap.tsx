/**
 * LocationPickerMap — an interactive Leaflet map for picking a single coordinate.
 * Click anywhere on the map to place/move a draggable marker.
 */
import { useCallback, useEffect } from 'react';
import { defaultIcon } from '../../lib/leaflet-setup';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';

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

export function LocationPickerMap({
  value,
  onChange,
  height = 300,
  center,
}: LocationPickerMapProps) {
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
      {value && (
        <Marker
          position={[value.lat, value.lng]}
          icon={defaultIcon}
          draggable
          eventHandlers={{ dragend: handleDrag }}
        />
      )}
    </MapContainer>
  );
}
