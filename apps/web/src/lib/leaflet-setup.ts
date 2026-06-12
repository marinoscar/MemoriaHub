/**
 * Leaflet icon fix for Vite.
 *
 * Leaflet's default marker icons break under bundlers like Vite because the
 * CSS references images via relative paths that the bundler does not resolve.
 * Importing this module (even as a side effect) applies the fix globally once.
 *
 * Usage:
 *   import '../../lib/leaflet-setup';          // side-effect import
 *   import { defaultIcon } from '../../lib/leaflet-setup'; // or use the icon
 */

import 'leaflet/dist/leaflet.css';

// Import the marker images explicitly so Vite processes them as assets.
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

import L from 'leaflet';

// Patch the default icon options once.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

/**
 * A configured default Leaflet marker icon.
 * Pass this to `<Marker icon={defaultIcon}>` so react-leaflet
 * uses the correctly resolved image URLs.
 */
export const defaultIcon = new L.Icon.Default();
