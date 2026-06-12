/**
 * LocationMiniMap — a compact Leaflet map that pins a single GPS coordinate.
 *
 * Importing this module applies the Leaflet Vite icon fix as a side effect
 * (via leaflet-setup.ts). The map renders at a fixed 200 px height with
 * scroll-wheel zoom disabled so it doesn't hijack page scroll inside the
 * detail drawer.
 */

import { defaultIcon } from '../../lib/leaflet-setup';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LocationMiniMapProps {
  lat: number;
  lng: number;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LocationMiniMap({ lat, lng, label }: LocationMiniMapProps) {
  const center: [number, number] = [lat, lng];

  return (
    <MapContainer
      center={center}
      zoom={13}
      scrollWheelZoom={false}
      style={{ height: 200, width: '100%', borderRadius: 8 }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      <Marker position={center} icon={defaultIcon}>
        {label ? <Popup>{label}</Popup> : null}
      </Marker>
    </MapContainer>
  );
}
