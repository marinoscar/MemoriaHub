/**
 * MapControls — a custom, theme-aware on-map control stack (top-left) that
 * replaces Leaflet's default zoom control. Rendered as a page-level absolutely
 * positioned overlay (like MapTimeFilter), driven by the Leaflet map instance
 * captured from inside <MapContainer>.
 *
 * Buttons: Zoom In, Zoom Out, Recenter-to-my-photos (fits the circle's photo
 * extent), and Go-to-my-location.
 *
 * IMPORTANT: geolocation is invoked ONLY by an explicit click on the "Go to my
 * location" button — never automatically.
 */

import { useState, useCallback } from 'react';
import L from 'leaflet';
import { Paper, IconButton, Divider, Tooltip, Snackbar, Alert } from '@mui/material';
import {
  Add,
  Remove,
  CenterFocusStrong,
  MyLocation,
} from '@mui/icons-material';
import type { LocationExtent } from '../../types/media';

interface MapControlsProps {
  /** The Leaflet map instance, captured from inside <MapContainer>. Null until ready. */
  map: L.Map | null;
  /** The circle's true photo bounding box, used by the recenter button. */
  extent: LocationExtent | null;
}

export function MapControls({ map, extent }: MapControlsProps) {
  const [geoError, setGeoError] = useState<string | null>(null);

  const handleZoomIn = useCallback(() => {
    map?.zoomIn();
  }, [map]);

  const handleZoomOut = useCallback(() => {
    map?.zoomOut();
  }, [map]);

  // Reuse the same framing logic as FitToExtent so the two stay in sync.
  const handleRecenter = useCallback(() => {
    if (!map || !extent) return;
    const { minLat, minLng, maxLat, maxLng } = extent;
    if (minLat === maxLat && minLng === maxLng) {
      map.setView([minLat, minLng], 13);
      return;
    }
    map.fitBounds(
      L.latLngBounds([
        [minLat, minLng],
        [maxLat, maxLng],
      ]),
      { padding: [40, 40] },
    );
  }, [map, extent]);

  // Geolocation runs ONLY on this explicit click — never automatically.
  const handleLocate = useCallback(() => {
    if (!map) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeoError('Geolocation is not supported by your browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 12);
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied.'
            : 'Could not determine your location.',
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }, [map]);

  const mapReady = map !== null;

  return (
    <>
      <Paper
        elevation={3}
        sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 1,
          overflow: 'hidden',
          backgroundColor: (t) =>
            t.palette.mode === 'dark'
              ? 'rgba(30,30,30,0.9)'
              : 'rgba(255,255,255,0.9)',
        }}
      >
        <Tooltip title="Zoom in" placement="right">
          <span>
            <IconButton
              size="small"
              onClick={handleZoomIn}
              disabled={!mapReady}
              aria-label="Zoom in"
            >
              <Add fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Zoom out" placement="right">
          <span>
            <IconButton
              size="small"
              onClick={handleZoomOut}
              disabled={!mapReady}
              aria-label="Zoom out"
            >
              <Remove fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Divider flexItem />

        <Tooltip title="Recenter to my photos" placement="right">
          <span>
            <IconButton
              size="small"
              onClick={handleRecenter}
              disabled={!mapReady || !extent}
              aria-label="Fit to my photos"
            >
              <CenterFocusStrong fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Go to my location" placement="right">
          <span>
            <IconButton
              size="small"
              onClick={handleLocate}
              disabled={!mapReady}
              aria-label="Go to my current location"
            >
              <MyLocation fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Paper>

      <Snackbar
        open={geoError !== null}
        autoHideDuration={4000}
        onClose={() => setGeoError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="warning"
          variant="filled"
          onClose={() => setGeoError(null)}
          sx={{ width: '100%' }}
        >
          {geoError}
        </Alert>
      </Snackbar>
    </>
  );
}
