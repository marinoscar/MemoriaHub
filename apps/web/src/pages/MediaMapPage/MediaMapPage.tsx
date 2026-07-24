/**
 * MediaMapPage — viewport-driven clustered map view of all geotagged media.
 *
 * - Fetches server-side grid clusters from GET /api/media/locations/aggregate
 *   for the CURRENT viewport (bbox + zoom-derived precision), debounced on
 *   pan/zoom. This keeps payloads bounded regardless of library size.
 * - Renders each cluster as a Leaflet marker: a count badge for multi-item
 *   cells, a normal pin for single-item cells.
 * - Clicking a multi-item cluster opens the "Photos here" drawer (a preview of
 *   the cluster's photos plus a "Show all" jump into search).
 * - Clicking a single-item marker opens MediaDetailDrawer for that item.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import {
  Box,
  Button,
  CircularProgress,
  Alert,
  Typography,
  Drawer,
  IconButton,
  Grid,
  Skeleton,
  Paper,
  useTheme,
} from '@mui/material';
import { Close as CloseIcon, Map as MapIcon } from '@mui/icons-material';
import '../../lib/leaflet-setup';
import {
  aggregateLocations,
  listMediaLocations,
  getThumbnails,
  getMedia,
  getLocationExtent,
} from '../../services/media';
import { AggregateClusterLayer } from '../../components/map/AggregateClusterLayer';
import { useCircle } from '../../hooks/useCircle';
import { useAuth } from '../../contexts/AuthContext';
import { useSearch } from '../../contexts/SearchContext';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import { MapTimeFilter, type MapTimeRange } from '../../components/map/MapTimeFilter';
import { MapControls } from '../../components/map/MapControls';
import type { MapCluster, MediaItem, MediaLocation, LocationExtent } from '../../types/media';

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

/**
 * Maximum number of thumbnails fetched for the "Photos here" drawer preview.
 * Kept well under the server-side `GET /api/media/thumbnails` cap of 200 ids so
 * a large cluster never overruns it; the full count is still shown in the title
 * and the "Show all" button drills into search for the complete set.
 */
const CLUSTER_THUMB_LIMIT = 24;

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
// FitToExtent — frames the map to the TRUE bounding box of the circle's
// geotagged photos (from GET /media/locations/extent), not the arbitrary
// default viewport. Re-fits whenever a fresh extent arrives (initial load,
// or after the time-range filter changes) — never during ordinary pan/zoom.
// ---------------------------------------------------------------------------

function FitToExtent({ extent }: { extent: LocationExtent | null }) {
  const map = useMap();

  useEffect(() => {
    if (!extent) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extent]);

  return null;
}

// ---------------------------------------------------------------------------
// CaptureMap — lifts the Leaflet map instance out of <MapContainer> so
// page-level overlays (MapControls) can drive it imperatively. useMap() only
// works inside <MapContainer>, so we capture it once on mount.
// ---------------------------------------------------------------------------

function CaptureMap({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();

  useEffect(() => {
    onReady(map);
  }, [map, onReady]);

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
// Main page component
// ---------------------------------------------------------------------------

export default function MediaMapPage() {
  const theme = useTheme();
  const { activeCircle } = useCircle();
  const { isLoading: authIsLoading } = useAuth();
  const { runDeterministicSearch } = useSearch();

  // Leaflet map instance, captured from inside <MapContainer> so page-level
  // overlays (MapControls) can drive it imperatively.
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const handleMapReady = useCallback((map: L.Map) => setMapInstance(map), []);

  // ----- Viewport-driven cluster data -----
  const [clusters, setClusters] = useState<MapCluster[]>([]);
  const [viewport, setViewport] = useState<{ bbox: string; zoom: number } | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extent, setExtent] = useState<LocationExtent | null>(null);
  const [extentResolved, setExtentResolved] = useState(false);

  const handleViewport = useCallback((bbox: string, zoom: number) => {
    setViewport({ bbox, zoom });
  }, []);

  // ----- Time-range filter -----
  const [timeRange, setTimeRange] = useState<MapTimeRange>({ from: null, to: null });
  const handleTimeChange = useCallback((range: MapTimeRange) => {
    setTimeRange(range);
  }, []);

  // Fetch aggregate clusters for the current viewport. Gated on auth bootstrap
  // completing so a cold reload doesn't fire a 401 before the token is ready.
  useEffect(() => {
    if (!activeCircle || authIsLoading || !viewport) return;

    let cancelled = false;
    setError(null);

    aggregateLocations({
      circleId: activeCircle.id,
      zoom: Math.round(viewport.zoom),
      bbox: viewport.bbox,
      capturedAtFrom: timeRange.from ?? undefined,
      capturedAtTo: timeRange.to ?? undefined,
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
  }, [activeCircle, authIsLoading, viewport, timeRange]);

  // Fetch the TRUE bounding-box extent for initial map framing. Deliberately
  // independent of the viewport-driven aggregate fetch above — runs once per
  // circle/time-range change, never on pan/zoom.
  useEffect(() => {
    if (!activeCircle || authIsLoading) return;
    let cancelled = false;
    setExtentResolved(false);

    getLocationExtent({
      circleId: activeCircle.id,
      capturedAtFrom: timeRange.from ?? undefined,
      capturedAtTo: timeRange.to ?? undefined,
    })
      .then((data) => {
        if (cancelled) return;
        setExtent(data);
        setExtentResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        setExtent(null);
        setExtentResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCircle, authIsLoading, timeRange]);

  // ----- "Photos here" cluster drawer (lazy points + thumbnails) -----
  // `clusterDrawer === null` means closed; otherwise the drawer is open and
  // `status` reflects the fetch lifecycle. `points` holds only the first
  // CLUSTER_THUMB_LIMIT items (with thumbnails merged in); `total` is the full
  // cluster size so the title and "Show all" button reflect every photo.
  type ClusterDrawerState = {
    status: 'loading' | 'loaded' | 'error';
    points: MediaLocation[];
    total: number;
    near: { lat: number; lng: number; radiusKm: number };
  };
  const [clusterDrawer, setClusterDrawer] = useState<ClusterDrawerState | null>(null);
  const albumReqRef = useRef(0);

  const handleOpenClusterBbox = useCallback(
    ({ bbox, lat, lng }: { bbox: string; lat: number; lng: number; total: number }) => {
      if (!activeCircle) return;
      const reqId = ++albumReqRef.current;
      const circleId = activeCircle.id;

      // Derive a "near" radius from the bbox diagonal so "Show all" searches the
      // same area the drawer previews. bbox is `minLng,minLat,maxLng,maxLat`.
      // Convert the lat/lng spans to km (~111.32 km/deg of latitude, longitude
      // scaled by cos(centerLat)), take half the diagonal, floored at 0.5 km.
      const [w, s, e, n] = bbox.split(',').map(Number);
      const latKm = (n - s) * 111.32;
      const lngKm = (e - w) * 111.32 * Math.cos((lat * Math.PI) / 180);
      const diagonalKm = Math.hypot(latKm, lngKm);
      const radiusKm = Math.max(0.5, diagonalKm / 2);
      const near = { lat, lng, radiusKm };

      // Open immediately in the loading state.
      setClusterDrawer({ status: 'loading', points: [], total: 0, near });

      void (async () => {
        try {
          const pts = await listMediaLocations({
            circleId,
            bbox,
            capturedAtFrom: timeRange.from ?? undefined,
            capturedAtTo: timeRange.to ?? undefined,
          });
          if (albumReqRef.current !== reqId) return;
          const total = pts.length;

          // Only request thumbnails for the first N points — the server caps
          // GET /api/media/thumbnails at 200 ids, and a large cluster would
          // blow past it.
          const head = pts.slice(0, CLUSTER_THUMB_LIMIT);
          const thumbs = await getThumbnails(
            circleId,
            head.map((p) => p.id),
          );
          if (albumReqRef.current !== reqId) return;
          const byId = new Map(thumbs.map((t) => [t.id, t.thumbnailUrl]));
          const headWithThumbs = head.map((p) => ({
            ...p,
            thumbnailUrl: byId.get(p.id) ?? null,
          }));
          setClusterDrawer({ status: 'loaded', points: headWithThumbs, total, near });
        } catch {
          if (albumReqRef.current === reqId) {
            setClusterDrawer({ status: 'error', points: [], total: 0, near });
          }
        }
      })();
    },
    [activeCircle, timeRange],
  );

  const handleCloseCluster = useCallback(() => {
    albumReqRef.current++; // invalidate any in-flight request
    setClusterDrawer(null);
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

  const loadingFirst = (!initialLoaded || !extentResolved) && !error;
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

      {/* Time-range filter overlay — floats above the Leaflet pane, top-right
          so it never overlaps the top-left MapControls stack. */}
      <Paper
        elevation={3}
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 1000,
          p: 0.5,
          borderRadius: 1,
          backgroundColor: (t) =>
            t.palette.mode === 'dark'
              ? 'rgba(30,30,30,0.9)'
              : 'rgba(255,255,255,0.9)',
        }}
      >
        <MapTimeFilter onChange={handleTimeChange} />
      </Paper>

      {/* Custom map control stack (top-left): zoom, recenter, locate */}
      <MapControls map={mapInstance} extent={extent} />

      {/* Map — always rendered so Leaflet initialises correctly */}
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ height: '100%', width: '100%' }}
        // Default zoom control replaced by the custom MapControls stack.
        zoomControl={false}
        // Disable scroll-wheel zoom while the cluster drawer is open.
        scrollWheelZoom={clusterDrawer === null}
      >
        {/* Theme-aware basemap: CARTO dark tiles in dark mode, light otherwise.
            The `key` forces react-leaflet to swap the layer cleanly on theme
            change. CARTO serves via subdomains a–d. */}
        <TileLayer
          key={theme.palette.mode}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={
            theme.palette.mode === 'dark'
              ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
              : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
          }
          subdomains="abcd"
        />

        {/* Capture the map instance for the page-level MapControls overlay */}
        <CaptureMap onReady={handleMapReady} />

        {/* Report viewport changes so the parent can refetch aggregates */}
        <ViewportWatcher onChange={handleViewport} />

        {/* Fit to the circle's true photo extent */}
        <FitToExtent extent={extent} />

        {/* Cluster markers — weighted markercluster layer (pixel-radius
            de-collision + animated re-cluster on zoom) */}
        <AggregateClusterLayer
          clusters={clusters}
          themeMode={theme.palette.mode}
          onOpenItem={handleMarkerOpen}
          onOpenClusterBbox={handleOpenClusterBbox}
        />
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
        open={clusterDrawer !== null}
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
          <Typography variant="h6">Photos here ({clusterDrawer?.total ?? 0})</Typography>
        </Box>

        <Box sx={{ p: 2, overflowY: 'auto', flex: 1 }}>
          {clusterDrawer?.status === 'error' ? (
            <Alert severity="error">Couldn&apos;t load photos for this location.</Alert>
          ) : clusterDrawer?.status === 'loading' ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress aria-label="Loading photos" />
            </Box>
          ) : (
            <>
              <Grid container spacing={1}>
                {(clusterDrawer?.points ?? []).map((point) => (
                  <Grid key={point.id} size={{ xs: 4 }}>
                    <AlbumTile point={point} onClick={() => handleMarkerOpen(point.id)} />
                  </Grid>
                ))}
              </Grid>

              {clusterDrawer &&
                clusterDrawer.status === 'loaded' &&
                clusterDrawer.total > clusterDrawer.points.length &&
                activeCircle && (
                  <Button
                    variant="contained"
                    fullWidth
                    sx={{ mt: 2 }}
                    onClick={() => {
                      runDeterministicSearch({
                        circleId: activeCircle.id,
                        filters: { near: clusterDrawer.near },
                      });
                      handleCloseCluster();
                    }}
                  >
                    Show all {clusterDrawer.total} photos
                  </Button>
                )}
            </>
          )}
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
