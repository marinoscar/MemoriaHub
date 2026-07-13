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
import {
  Box,
  CircularProgress,
  Alert,
  Typography,
  Drawer,
  IconButton,
  Grid,
  Skeleton,
  useTheme,
} from '@mui/material';
import { Close as CloseIcon, Map as MapIcon } from '@mui/icons-material';
import '../../lib/leaflet-setup';
import { defaultIcon } from '../../lib/leaflet-setup';
import {
  aggregateLocations,
  listMediaLocations,
  getThumbnails,
  getMedia,
} from '../../services/media';
import { useCircle } from '../../hooks/useCircle';
import { useAuth } from '../../contexts/AuthContext';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import type { MapCluster, MediaItem, MediaLocation } from '../../types/media';

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

/**
 * Clusters at or below this member count open the "Photos here" drawer
 * (fetch + show thumbnails) instead of flying in to drill down further.
 */
const CLUSTER_DRAWER_MAX = 60;

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
// AlbumTile — thumbnail inside the "Photos here" cluster drawer. Shows a
// Skeleton until its (lazily-fetched) thumbnail URL resolves.
// ---------------------------------------------------------------------------

interface AlbumTileProps {
  point: MediaLocation;
  onClick: () => void;
}

function AlbumTile({ point, onClick }: AlbumTileProps) {
  const theme = useTheme();
  const [imgError, setImgError] = useState(false);

  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={
        point.geoLocality ??
        `Photo taken at ${point.takenLat.toFixed(4)}, ${point.takenLng.toFixed(4)}`
      }
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      sx={{
        aspectRatio: '1',
        cursor: 'pointer',
        borderRadius: 1,
        overflow: 'hidden',
        border: `1px solid ${theme.palette.divider}`,
        '&:hover': { opacity: 0.85 },
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.grey[900],
      }}
    >
      {point.thumbnailUrl && !imgError ? (
        <Box
          component="img"
          src={point.thumbnailUrl}
          alt={point.geoLocality ?? 'Photo'}
          onError={() => setImgError(true)}
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <Skeleton variant="rectangular" width="100%" height="100%" />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ClusterLayer — renders one Leaflet marker per aggregate cluster and handles
// clicks: single-item cells open the media drawer, small clusters open the
// "Photos here" drawer, larger clusters fly in one drill-down level.
// ---------------------------------------------------------------------------

interface ClusterLayerProps {
  clusters: MapCluster[];
  onOpenItem: (id: string) => void;
  onOpenCluster: (cluster: MapCluster, precision: number) => void;
}

function ClusterLayer({ clusters, onOpenItem, onOpenCluster }: ClusterLayerProps) {
  const map = useMap();

  const handleClick = useCallback(
    (cluster: MapCluster) => {
      if (cluster.count === 1) {
        onOpenItem(cluster.sampleId);
        return;
      }
      if (cluster.count <= CLUSTER_DRAWER_MAX) {
        onOpenCluster(cluster, precisionForZoom(map.getZoom()));
        return;
      }
      const target = Math.min(map.getZoom() + DRILL_ZOOM_STEP, map.getMaxZoom());
      map.flyTo([cluster.lat, cluster.lng], target);
    },
    [map, onOpenItem, onOpenCluster],
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

  // ----- "Photos here" cluster drawer (lazy points + thumbnails) -----
  // null = closed; [] = open + loading; populated array = loaded.
  const [albumPoints, setAlbumPoints] = useState<MediaLocation[] | null>(null);
  const albumReqRef = useRef(0);

  const handleOpenCluster = useCallback(
    (cluster: MapCluster, precision: number) => {
      if (!activeCircle) return;
      const reqId = ++albumReqRef.current;
      const circleId = activeCircle.id;
      setAlbumPoints([]); // open in loading state

      // Cell bounds: half a grid cell each way around the cluster centroid.
      const half = 0.5 * Math.pow(10, -precision);
      const bbox = `${cluster.lng - half},${cluster.lat - half},${cluster.lng + half},${cluster.lat + half}`;

      void (async () => {
        try {
          const pts = await listMediaLocations({ circleId, bbox });
          if (albumReqRef.current !== reqId) return;
          setAlbumPoints(pts);

          const thumbs = await getThumbnails(
            circleId,
            pts.map((p) => p.id),
          );
          if (albumReqRef.current !== reqId) return;
          const byId = new Map(thumbs.map((t) => [t.id, t.thumbnailUrl]));
          setAlbumPoints(
            pts.map((p) => ({ ...p, thumbnailUrl: byId.get(p.id) ?? null })),
          );
        } catch {
          if (albumReqRef.current === reqId) setAlbumPoints([]);
        }
      })();
    },
    [activeCircle],
  );

  const handleCloseCluster = useCallback(() => {
    albumReqRef.current++; // invalidate any in-flight request
    setAlbumPoints(null);
  }, []);

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
        // Disable scroll-wheel zoom while the cluster drawer is open.
        scrollWheelZoom={albumPoints === null}
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
        <ClusterLayer
          clusters={clusters}
          onOpenItem={handleMarkerOpen}
          onOpenCluster={handleOpenCluster}
        />

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

      {/* "Photos here" cluster drawer — lazy points + batched thumbnails */}
      <Drawer
        anchor="right"
        open={albumPoints !== null}
        onClose={handleCloseCluster}
        variant="temporary"
        ModalProps={{ keepMounted: false }}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100vw', sm: 400 },
            maxWidth: '100vw',
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 2,
            py: 1.5,
            borderBottom: `1px solid ${theme.palette.divider}`,
            gap: 1,
          }}
        >
          <IconButton onClick={handleCloseCluster} size="small" aria-label="Close photos panel">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6">Photos here ({albumPoints?.length ?? 0})</Typography>
        </Box>

        <Box sx={{ p: 2, overflowY: 'auto', flex: 1 }}>
          <Grid container spacing={1}>
            {(albumPoints ?? []).map((point) => (
              <Grid key={point.id} size={{ xs: 4 }}>
                <AlbumTile point={point} onClick={() => handleMarkerOpen(point.id)} />
              </Grid>
            ))}
          </Grid>
        </Box>
      </Drawer>

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
