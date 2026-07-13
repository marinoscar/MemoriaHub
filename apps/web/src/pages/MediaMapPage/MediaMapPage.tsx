/**
 * MediaMapPage — viewport-driven clustered map view of all geotagged media.
 *
 * - Fetches server-side grid clusters from GET /api/media/locations/aggregate
 *   for the CURRENT viewport (bbox + zoom-derived precision), debounced on
 *   pan/zoom. This keeps payloads bounded regardless of library size.
 * - Renders each cluster as a Leaflet marker: a count badge for multi-item
 *   cells, a normal pin for single-item cells.
 * - Clicking a multi-item cluster flies in one drill-down level; the moveend
 *   handler refetches at finer precision.
 * - Clicking a single-item marker opens MediaDetailDrawer for that item.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Box, CircularProgress, Alert, Typography, useTheme } from '@mui/material';
import { Map as MapIcon } from '@mui/icons-material';
import '../../lib/leaflet-setup';
import { defaultIcon } from '../../lib/leaflet-setup';
import { aggregateLocations, getMedia } from '../../services/media';
import { useCircle } from '../../hooks/useCircle';
import { useAuth } from '../../contexts/AuthContext';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import type { MapCluster, MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MUI default toolbar (AppBar) heights: 56px below the sm breakpoint, 64px at
 * sm and up. The map fills the remaining viewport height below it. `100dvh`
 * (dynamic viewport height) accounts for mobile browser chrome that `100vh`
 * ignores.
 */
const MAP_HEIGHT = {
  xs: 'calc(100dvh - 56px)',
  sm: 'calc(100dvh - 64px)',
} as const;

/** Default map view used before locations load (world overview). */
const DEFAULT_CENTER: L.LatLngExpression = [20, 0];
const DEFAULT_ZOOM = 2;

/** Debounce (ms) applied to viewport change events before refetching. */
const VIEWPORT_DEBOUNCE_MS = 250;

/** How many zoom levels a cluster drill-down flies in. */
const DRILL_ZOOM_STEP = 3;

// ---------------------------------------------------------------------------
// Zoom → grid precision. Coarser cells at low zoom keep bucket counts bounded.
// ---------------------------------------------------------------------------

function precisionForZoom(zoom: number): number {
  if (zoom <= 3) return 0;
  if (zoom <= 5) return 1;
  if (zoom <= 8) return 2;
  if (zoom <= 11) return 3;
  if (zoom <= 14) return 4;
  return 5;
}

// ---------------------------------------------------------------------------
// Cluster count-badge divIcon (styled like leaflet.markercluster defaults).
// ---------------------------------------------------------------------------

(function injectClusterIconStyles() {
  if (typeof document === 'undefined') return; // SSR guard
  const id = 'mh-cluster-icon-styles';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = [
    '.mh-cluster-icon { background: transparent !important; border: none !important; }',
    '.mh-cluster-icon > div {',
    '  width: 100%; height: 100%; border-radius: 50%;',
    '  display: flex; align-items: center; justify-content: center;',
    '  font: 600 12px/1 system-ui, sans-serif; color: #fff;',
    '  background: rgba(25, 118, 210, 0.85);',
    '  box-shadow: 0 0 0 4px rgba(25, 118, 210, 0.35);',
    '}',
  ].join('\n');
  document.head.appendChild(style);
})();

function clusterLabel(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${Math.floor(count / 100) / 10}k`;
  return `${Math.floor(count / 1000)}k`;
}

function clusterIcon(count: number): L.DivIcon {
  const size = count < 10 ? 34 : count < 100 ? 40 : count < 1000 ? 48 : 56;
  return L.divIcon({
    className: 'mh-cluster-icon',
    html: `<div>${clusterLabel(count)}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ---------------------------------------------------------------------------
// ViewportWatcher — reports the current bbox + zoom on mount and (debounced)
// after every pan/zoom, via useMap() + useMapEvents().
// ---------------------------------------------------------------------------

interface ViewportWatcherProps {
  onChange: (bbox: string, zoom: number) => void;
}

function ViewportWatcher({ onChange }: ViewportWatcherProps) {
  const map = useMap();
  const timerRef = useRef<number | null>(null);

  const emit = useCallback(() => {
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    onChange(bbox, map.getZoom());
  }, [map, onChange]);

  // Initial emit once the map is ready (MapContainer does not fire moveend for
  // the initial view).
  useEffect(() => {
    emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedEmit = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(emit, VIEWPORT_DEBOUNCE_MS);
  }, [emit]);

  useMapEvents({
    moveend: debouncedEmit,
    zoomend: debouncedEmit,
  });

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return null;
}

// ---------------------------------------------------------------------------
// FitToClusters — fits the map to the cluster extent on the FIRST load only.
// After the user pans/zooms, the map is never auto-refit.
// ---------------------------------------------------------------------------

function FitToClusters({ clusters }: { clusters: MapCluster[] }) {
  const map = useMap();
  const fittedRef = useRef(false);

  useEffect(() => {
    if (fittedRef.current) return;
    if (clusters.length === 0) return;
    fittedRef.current = true;

    if (clusters.length === 1) {
      map.setView([clusters[0].lat, clusters[0].lng], 13);
      return;
    }
    const bounds = L.latLngBounds(
      clusters.map((c) => [c.lat, c.lng] as L.LatLngTuple),
    );
    map.fitBounds(bounds, { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusters]);

  return null;
}

// ---------------------------------------------------------------------------
// GeoLocationCenter — centers the map to the user's geolocation when empty.
// ---------------------------------------------------------------------------

function GeoLocationCenter() {
  const map = useMap();
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    requestedRef.current = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 10);
      },
      () => {
        // denied or timeout — keep world overview
      },
      { timeout: 8000 },
    );
  }, [map]);

  return null;
}

// ---------------------------------------------------------------------------
// ClusterLayer — renders one Leaflet marker per aggregate cluster and handles
// clicks (drill-down for multi-item cells, open drawer for single-item cells).
// ---------------------------------------------------------------------------

interface ClusterLayerProps {
  clusters: MapCluster[];
  onOpenItem: (id: string) => void;
}

function ClusterLayer({ clusters, onOpenItem }: ClusterLayerProps) {
  const map = useMap();

  const handleClick = useCallback(
    (cluster: MapCluster) => {
      if (cluster.count === 1) {
        onOpenItem(cluster.sampleId);
        return;
      }
      const target = Math.min(map.getZoom() + DRILL_ZOOM_STEP, map.getMaxZoom());
      map.flyTo([cluster.lat, cluster.lng], target);
    },
    [map, onOpenItem],
  );

  return (
    <>
      {clusters.map((cluster) => (
        <Marker
          key={cluster.sampleId}
          position={[cluster.lat, cluster.lng]}
          icon={cluster.count > 1 ? clusterIcon(cluster.count) : defaultIcon}
          eventHandlers={{ click: () => handleClick(cluster) }}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function MediaMapPage() {
  const theme = useTheme();
  const { activeCircle } = useCircle();
  const { isLoading: authIsLoading } = useAuth();

  // ----- Viewport-driven cluster data -----
  const [clusters, setClusters] = useState<MapCluster[]>([]);
  const [viewport, setViewport] = useState<{ bbox: string; zoom: number } | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleViewport = useCallback((bbox: string, zoom: number) => {
    setViewport({ bbox, zoom });
  }, []);

  // Fetch aggregate clusters for the current viewport. Gated on auth bootstrap
  // completing so a cold reload doesn't fire a 401 before the token is ready.
  useEffect(() => {
    if (!activeCircle || authIsLoading || !viewport) return;

    let cancelled = false;
    setError(null);

    aggregateLocations({
      circleId: activeCircle.id,
      precision: precisionForZoom(viewport.zoom),
      bbox: viewport.bbox,
    })
      .then((data) => {
        if (cancelled) return;
        setClusters(data);
        setInitialLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load map data');
        setInitialLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCircle, authIsLoading, viewport]);

  // ----- MediaDetailDrawer (single item) -----
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fetchingItem, setFetchingItem] = useState(false);

  const openDrawerForId = useCallback(async (id: string) => {
    setFetchingItem(true);
    try {
      const full = await getMedia(id);
      setSelectedItem(full);
      setDrawerOpen(true);
    } catch {
      // Silently fail — the user can retry by clicking again
    } finally {
      setFetchingItem(false);
    }
  }, []);

  const handleMarkerOpen = useCallback(
    (id: string) => {
      void openDrawerForId(id);
    },
    [openDrawerForId],
  );

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
    setSelectedItem(null);
  }, []);

  const handleItemUpdated = useCallback((updated: MediaItem) => {
    setSelectedItem(updated);
  }, []);

  // ----- Render -----

  if (!activeCircle) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">Select a circle to view the map.</Alert>
      </Box>
    );
  }

  const loadingFirst = !initialLoaded && !error;
  const showEmpty = initialLoaded && !error && clusters.length === 0;

  return (
    <Box
      sx={{
        position: 'relative',
        height: MAP_HEIGHT,
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Initial loading overlay */}
      {loadingFirst && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.palette.background.paper,
          }}
        >
          <CircularProgress aria-label="Loading map data" />
        </Box>
      )}

      {/* Error state */}
      {error && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 3,
            pointerEvents: 'none',
          }}
        >
          <Alert severity="error" sx={{ maxWidth: 480 }}>
            {error}
          </Alert>
        </Box>
      )}

      {/* Empty state — shown when the viewport has no geotagged items */}
      {showEmpty && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            pointerEvents: 'none',
          }}
        >
          <MapIcon sx={{ fontSize: 64, color: 'text.disabled' }} />
          <Typography variant="h6" color="text.secondary">
            No geotagged media here
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', maxWidth: 360 }}>
            Add photos with GPS data, or pan the map to a region with photos.
          </Typography>
        </Box>
      )}

      {/* Map — always rendered so Leaflet initialises correctly */}
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Report viewport changes so the parent can refetch aggregates */}
        <ViewportWatcher onChange={handleViewport} />

        {/* Fit to the cluster extent once, on the first load */}
        <FitToClusters clusters={clusters} />

        {/* Cluster markers */}
        <ClusterLayer clusters={clusters} onOpenItem={handleMarkerOpen} />

        {/* Center on the user's geolocation when nothing is visible */}
        {showEmpty && <GeoLocationCenter />}
      </MapContainer>

      {/* Fetching-item spinner — briefly shown while getMedia is in flight */}
      {fetchingItem && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2000,
            backgroundColor: theme.palette.background.paper,
            borderRadius: '50%',
            p: 1,
            boxShadow: 3,
          }}
        >
          <CircularProgress size={28} aria-label="Loading item" />
        </Box>
      )}

      {/* Full media detail drawer */}
      <MediaDetailDrawer
        item={selectedItem}
        open={drawerOpen}
        onClose={handleDrawerClose}
        onItemUpdated={handleItemUpdated}
      />
    </Box>
  );
}
