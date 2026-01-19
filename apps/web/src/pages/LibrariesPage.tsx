import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Button, Alert, Paper } from '@mui/material';
import { Add as AddIcon, PhotoLibrary as EmptyIcon } from '@mui/icons-material';
import type { LibraryDTO } from '@memoriahub/shared';
import { useLibraries } from '../hooks';
import { LibraryGrid, CreateLibraryDialog } from '../components/library';

/**
 * Empty state when user has no libraries
 */
function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <Paper
      sx={{
        p: 6,
        textAlign: 'center',
        bgcolor: 'background.default',
      }}
    >
      <EmptyIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        No libraries yet
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Create your first library to start organizing your photos and videos.
      </Typography>
      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={onCreateClick}
      >
        Create Library
      </Button>
    </Paper>
  );
}

/**
 * Libraries page showing all libraries the user owns or has access to
 */
export function LibrariesPage() {
  const navigate = useNavigate();
  const { libraries, isLoading, error, refresh } = useLibraries();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const handleLibraryClick = (library: LibraryDTO) => {
    navigate(`/libraries/${library.id}`);
  };

  const handleLibraryCreated = (library: LibraryDTO) => {
    setCreateDialogOpen(false);
    // Navigate to the newly created library
    navigate(`/libraries/${library.id}`);
  };

  return (
    <Box>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
        }}
      >
        <Box>
          <Typography variant="h4" component="h1" gutterBottom>
            Libraries
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Organize your photos and videos into libraries
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateDialogOpen(true)}
        >
          Create Library
        </Button>
      </Box>

      {/* Error state */}
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => void refresh()}>
          {error}
        </Alert>
      )}

      {/* Content */}
      {!isLoading && !error && libraries.length === 0 ? (
        <EmptyState onCreateClick={() => setCreateDialogOpen(true)} />
      ) : (
        <LibraryGrid
          libraries={libraries}
          isLoading={isLoading}
          onLibraryClick={handleLibraryClick}
        />
      )}

      {/* Create library dialog */}
      <CreateLibraryDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={handleLibraryCreated}
      />
    </Box>
  );
}
