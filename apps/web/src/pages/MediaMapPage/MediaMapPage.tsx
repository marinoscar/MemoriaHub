/**
 * MediaMapPage — clustered map view of all geotagged media.
 *
 * - Loads all geotagged items from GET /api/media/locations.
 * - Renders a Leaflet map with marker clustering.
 * - Clicking a cluster opens an album panel (Drawer) with thumbnails.
 * - Clicking a thumbnail or a single marker opens MediaDetailDrawer for that item.
 * - The drawer receives a fully-fetched MediaItem (via getMedia) so the video
 *   player has a downloadUrl and no extra fetch is needed inside the drawer.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
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
import { listMediaLocations, getMedia } from '../../services/media';
import { useCircle } from '../../hooks/useCircle';
import { MarkerClusterGroup } from '../../components/map/MarkerClusterGroup';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import type { MediaLocation, MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Height of the MUI AppBar — keeps the map below it. */
const APPBAR_HEIGHT = 64;

/** Default map view used before locations load (world overview). */
const DEFAULT_CENTER: L.LatLngExpression = [20, 0];
const DEFAULT_ZOOM = 2;

// ---------------------------------------------------------------------------
// FitBounds — child component that fits the map to loaded points via useMap()
// ---------------------------------------------------------------------------

interface FitBoundsProps {
  points: MediaLocation[];
}

function FitBounds({ points }: FitBoundsProps) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;

    if (points.length === 1) {
      map.setView([points[0].takenLat, points[0].takenLng], 13);
      return;
    }

    const bounds = L.latLngBounds(
      points.map((p) => [p.takenLat, p.takenLng] as L.LatLngTuple),
    );
    map.fitBounds(bounds, { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  return null;
}

// ---------------------------------------------------------------------------
// GeoLocationCenter — centers the map to user's geolocation when there are no points
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
// AlbumTile — thumbnail inside the cluster album drawer
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
      aria-label={point.geoLocality ?? `Photo taken at ${point.takenLat.toFixed(4)}, ${point.takenLng.toFixed(4)}`}
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

  // ----- Location data -----
  const [points, setPoints] = useState<MediaLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCircle) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    listMediaLocations({ circleId: activeCircle.id })
      .then((data) => {
        if (!cancelled) {
          setPoints(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load map data');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeCircle]);

  // ----- Album panel (cluster click) -----
  const [albumIds, setAlbumIds] = useState<string[] | null>(null);
  const albumPoints =
    albumIds !== null
      ? points.filter((p) => albumIds.includes(p.id))
      : [];

  const handleClusterClick = useCallback((ids: string[]) => {
    setAlbumIds(ids);
  }, []);

  const handleCloseAlbum = useCallback(() => {
    setAlbumIds(null);
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

  const handleMarkerClick = useCallback(
    (id: string) => {
      void openDrawerForId(id);
    },
    [openDrawerForId],
  );

  const handleAlbumTileClick = useCallback(
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

  return (
    <Box
      sx={{
        position: 'relative',
        height: `calc(100vh - ${APPBAR_HEIGHT}px)`,
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Loading overlay */}
      {loading && (
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
      {error && !loading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 3,
          }}
        >
          <Alert severity="error" sx={{ maxWidth: 480 }}>
            {error}
          </Alert>
        </Box>
      )}

      {/* Empty state — shown after load when there are no geotagged items */}
      {!loading && !error && points.length === 0 && (
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
          }}
        >
          <MapIcon sx={{ fontSize: 64, color: 'text.disabled' }} />
          <Typography variant="h6" color="text.secondary">
            No geotagged media yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', maxWidth: 360 }}>
            Add photos with GPS data to see them here.
          </Typography>
        </Box>
      )}

      {/* Map — always rendered so Leaflet initialises correctly */}
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ height: '100%', width: '100%' }}
        // Disable scroll-wheel zoom when album drawer is open to avoid conflicts
        scrollWheelZoom={albumIds === null}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Fit bounds once locations are loaded */}
        {!loading && points.length > 0 && <FitBounds points={points} />}

        {/* Clustered markers */}
        {!loading && points.length > 0 && (
          <MarkerClusterGroup
            points={points}
            onClusterClick={handleClusterClick}
            onMarkerClick={handleMarkerClick}
          />
        )}

        {/* Center on user's geolocation when no points are loaded */}
        {!loading && points.length === 0 && <GeoLocationCenter />}
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

      {/* Album panel — slides in from the right when a cluster is clicked */}
      <Drawer
        anchor="right"
        open={albumIds !== null}
        onClose={handleCloseAlbum}
        variant="temporary"
        ModalProps={{ keepMounted: false }}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100vw', sm: 400 },
            maxWidth: '100vw',
          },
        }}
      >
        {/* Header */}
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
          <IconButton onClick={handleCloseAlbum} size="small" aria-label="Close album panel">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6">
            Photos here ({albumPoints.length})
          </Typography>
        </Box>

        {/* Thumbnail grid */}
        <Box sx={{ p: 2, overflowY: 'auto', flex: 1 }}>
          <Grid container spacing={1}>
            {albumPoints.map((point) => (
              <Grid key={point.id} size={{ xs: 4 }}>
                <AlbumTile
                  point={point}
                  onClick={() => handleAlbumTileClick(point.id)}
                />
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
