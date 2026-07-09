import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Grid,
  Card,
  CardActionArea,
  CardContent,
} from '@mui/material';
import { Add as AddIcon, PhotoAlbum as PhotoAlbumIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useAlbums } from '../../hooks/useAlbums';
import { CreateAlbumDialog } from '../../components/album/CreateAlbumDialog';
import type { Album } from '../../types/media';

/**
 * Format an album's date range for the card secondary line.
 * - null / empty → '' (caller omits the line)
 * - same year → 'YYYY'
 * - spanning years → 'YYYY – YYYY'
 */
function formatDateRange(dateRange: Album['dateRange']): string {
  if (!dateRange) return '';
  const minYear = new Date(dateRange.min).getFullYear();
  const maxYear = new Date(dateRange.max).getFullYear();
  if (Number.isNaN(minYear) || Number.isNaN(maxYear)) return '';
  if (minYear === maxYear) return String(minYear);
  return `${minYear} – ${maxYear}`;
}

function AlbumCard({ album, onOpen }: { album: Album; onOpen: () => void }) {
  const dateRangeLabel = formatDateRange(album.dateRange);
  const itemCount = album.itemCount ?? 0;

  return (
    <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardActionArea
        onClick={onOpen}
        sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
      >
        {/* Cover image / placeholder */}
        <Box
          sx={{
            position: 'relative',
            width: '100%',
            aspectRatio: '4 / 3',
            bgcolor: 'action.hover',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {album.coverThumbnailUrl ? (
            <Box
              component="img"
              src={album.coverThumbnailUrl}
              alt={album.name}
              loading="lazy"
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <PhotoAlbumIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
          )}
        </Box>

        <CardContent sx={{ width: '100%', flexGrow: 1 }}>
          <Typography variant="subtitle1" noWrap title={album.name} sx={{ fontWeight: 600 }}>
            {album.name}
          </Typography>
          {dateRangeLabel && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {dateRangeLabel}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function AlbumsPage() {
  const navigate = useNavigate();
  const { activeCircle, activeCircleRole } = useCircle();
  const { albums, isLoading, error, fetchAlbums } = useAlbums();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!activeCircle) return;
    void fetchAlbums({ circleId: activeCircle.id, pageSize: 100, sortBy: 'name', sortOrder: 'asc' });
  }, [activeCircle, fetchAlbums]);

  const isViewer = activeCircleRole === 'viewer';

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view albums.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h5" component="h1">
          Albums
        </Typography>
        {!isViewer && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ minHeight: 44 }}
          >
            New Album
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {!isLoading && albums.length === 0 && !error && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <PhotoAlbumIcon sx={{ fontSize: 56, color: 'text.disabled', mb: 1 }} />
          <Typography variant="h6" color="text.secondary">
            No albums yet
          </Typography>
          {!isViewer && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Create an album to organize your photos and videos.
            </Typography>
          )}
        </Box>
      )}

      {!isLoading && albums.length > 0 && (
        <Grid container spacing={2}>
          {albums.map((album: Album) => (
            <Grid key={album.id} size={{ xs: 6, sm: 4, md: 3, lg: 2 }}>
              <AlbumCard album={album} onOpen={() => navigate(`/albums/${album.id}`)} />
            </Grid>
          ))}
        </Grid>
      )}

      <CreateAlbumDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        circleId={activeCircle.id}
        onCreated={(album) => {
          setCreateOpen(false);
          navigate(`/albums/${album.id}`);
        }}
      />
    </Box>
  );
}
