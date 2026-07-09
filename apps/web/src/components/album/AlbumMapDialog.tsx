/**
 * AlbumMapDialog — a fullWidth dialog plotting an album's geotagged items on a
 * Leaflet map. Mirrors MediaMapPage's marker/cluster patterns but scoped to a
 * single album via GET /api/media/locations?albumId=.
 */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  IconButton,
  Typography,
  CircularProgress,
  Alert,
  useTheme,
} from '@mui/material';
import { Close as CloseIcon, Map as MapIcon } from '@mui/icons-material';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import '../../lib/leaflet-setup';
import { MarkerClusterGroup } from '../map/MarkerClusterGroup';
import { listAlbumLocations } from '../../services/media';
import type { MediaLocation } from '../../types/media';

const DEFAULT_CENTER: L.LatLngExpression = [20, 0];
const DEFAULT_ZOOM = 2;

interface AlbumMapDialogProps {
  open: boolean;
  onClose: () => void;
  albumId: string;
  circleId: string;
}

/** Fits the map to the loaded points once they arrive. */
function FitBounds({ points }: { points: MediaLocation[] }) {
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
    // Leaflet needs a nudge after the dialog transition settles.
    setTimeout(() => map.invalidateSize(), 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  return null;
}

export function AlbumMapDialog({ open, onClose, albumId, circleId }: AlbumMapDialogProps) {
  const theme = useTheme();
  const [points, setPoints] = useState<MediaLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAlbumLocations(albumId, circleId)
      .then((data) => {
        if (!cancelled) setPoints(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load map data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, albumId, circleId]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        Map
        <IconButton
          aria-label="Close map"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ position: 'relative', height: { xs: '60vh', md: '70vh' }, width: '100%' }}>
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

          {error && !loading && (
            <Box sx={{ position: 'absolute', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
              <Alert severity="error" sx={{ maxWidth: 480 }}>
                {error}
              </Alert>
            </Box>
          )}

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
                gap: 1.5,
                textAlign: 'center',
                px: 3,
              }}
            >
              <MapIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
              <Typography variant="h6" color="text.secondary">
                No geotagged photos in this album
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 360 }}>
                Photos with GPS data will appear here on the map.
              </Typography>
            </Box>
          )}

          <MapContainer
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {!loading && points.length > 0 && <FitBounds points={points} />}
            {!loading && points.length > 0 && (
              <MarkerClusterGroup
                points={points}
                onClusterClick={() => {}}
                onMarkerClick={() => {}}
              />
            )}
          </MapContainer>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
