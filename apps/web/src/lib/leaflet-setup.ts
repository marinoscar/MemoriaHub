/**
 * Leaflet icon setup for Vite.
 *
 * The PNG marker images from leaflet/dist/images break under Vite because the
 * bundler serves the import URL as text/javascript (ESM re-export of the asset
 * path) when that URL is used directly as an <img src>. This is a known
 * Leaflet+Vite/optimizeDeps issue.
 *
 * Fix: use an inline-SVG divIcon so no external image request is needed.
 * The SVG is a teardrop map-pin with tip at bottom-center matching
 * iconAnchor [12, 41] (the Leaflet default geometry).
 *
 * Usage:
 *   import '../../lib/leaflet-setup';          // side-effect import
 *   import { defaultIcon } from '../../lib/leaflet-setup'; // or use the icon
 */

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// ---------------------------------------------------------------------------
// Neutralize the default .leaflet-div-icon box styling.
//
// Leaflet adds a white background + gray border to every divIcon element via
// its built-in .leaflet-div-icon rule. Our SVG pin must be transparent, so we
// override those properties scoped to our class so that other divIcons (e.g.
// cluster labels) are not affected.
// ---------------------------------------------------------------------------
(function injectMarkerIconStyles() {
  if (typeof document === 'undefined') return; // SSR guard
  const id = 'mh-marker-icon-styles';
  if (document.getElementById(id)) return; // only inject once
  const style = document.createElement('style');
  style.id = id;
  style.textContent = [
    '.mh-marker-icon {',
    '  background: transparent !important;',
    '  border: none !important;',
    '}',
  ].join('\n');
  document.head.appendChild(style);
})();

// ---------------------------------------------------------------------------
// Inline-SVG teardrop map pin.
//
// Dimensions: 25 × 41 px (matches Leaflet's default marker geometry).
// Tip is at bottom-center → iconAnchor [12, 41].
// A drop shadow filter adds depth without requiring an extra image.
// ---------------------------------------------------------------------------
const PIN_SVG = `<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 25 41"
  width="25"
  height="41"
  aria-hidden="true"
>
  <defs>
    <filter id="mh-pin-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#00000055"/>
    </filter>
  </defs>
  <!-- Teardrop body: circle top, tapered to a point at bottom-center -->
  <path
    d="M12.5 0
       C5.6 0 0 5.6 0 12.5
       C0 19.4 12.5 41 12.5 41
       C12.5 41 25 19.4 25 12.5
       C25 5.6 19.4 0 12.5 0Z"
    fill="#1976d2"
    stroke="#0d47a1"
    stroke-width="1"
    filter="url(#mh-pin-shadow)"
  />
  <!-- White inner circle -->
  <circle cx="12.5" cy="12" r="5" fill="#ffffff" opacity="0.9"/>
</svg>`;

/**
 * A divIcon using an inline SVG map-pin.
 *
 * Eliminates all external image requests and works correctly in every
 * environment (dev, prod, nginx, retina, mobile).
 *
 * Pass this to `<Marker icon={defaultIcon}>` or `L.marker(latlng, { icon: defaultIcon })`.
 */
export const defaultIcon = L.divIcon({
  className: 'mh-marker-icon',
  html: PIN_SVG,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});
