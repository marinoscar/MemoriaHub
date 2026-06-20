import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useAlbums } from '../../hooks/useAlbums';
import { CreateAlbumDialog } from '../../components/album/CreateAlbumDialog';
import type { Album } from '../../types/media';

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
        <List disablePadding>
          {albums.map((album: Album) => (
            <ListItem
              key={album.id}
              disablePadding
              sx={{ borderBottom: '1px solid', borderColor: 'divider' }}
            >
              <ListItemButton
                onClick={() => navigate(`/albums/${album.id}`)}
                sx={{ py: 1.5 }}
              >
                <ListItemText
                  primary={album.name}
                  secondary={album.description ?? undefined}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
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
