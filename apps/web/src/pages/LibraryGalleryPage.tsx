import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  Alert,
  Breadcrumbs,
  Link,
  CircularProgress,
  Chip,
  Snackbar,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  ArrowBack as BackIcon,
  Lock as PrivateIcon,
  People as SharedIcon,
  Public as PublicIcon,
} from '@mui/icons-material';
import { useLibrary, useMedia, useMediaSelection } from '../hooks';
import { GalleryFilters, MediaLightbox, type FilterState } from '../components/gallery';
import { SelectableMediaGrid } from '../components/gallery/SelectableMediaGrid';
import { BulkActionsToolbar } from '../components/gallery/BulkActionsToolbar';
import { UploadDialog } from '../components/upload';
import { BulkMetadataDialog, type BulkMetadataUpdate } from '../components/dialogs/BulkMetadataDialog';
import { AddToLibraryDialog } from '../components/dialogs/AddToLibraryDialog';
import { BulkDeleteDialog } from '../components/dialogs/BulkDeleteDialog';
import { mediaApi } from '../services/api/media.api';
import { libraryApi } from '../services/api/library.api';
import { useLibraries } from '../hooks';

/**
 * Get visibility icon
 */
function getVisibilityIcon(visibility: string) {
  switch (visibility) {
    case 'shared':
      return <SharedIcon fontSize="small" />;
    case 'public':
      return <PublicIcon fontSize="small" />;
    default:
      return <PrivateIcon fontSize="small" />;
  }
}

/**
 * Library gallery page showing media inside a library
 */
export function LibraryGalleryPage() {
  const { libraryId } = useParams<{ libraryId: string }>();
  const navigate = useNavigate();

  // Filter state
  const [filters, setFilters] = useState<FilterState>({
    mediaType: 'all',
    sortBy: 'capturedAt',
    sortOrder: 'desc',
  });

  // Lightbox state
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);

  // Upload dialog state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  // Selection state
  const {
    selectedIds,
    toggleSelection,
    selectAll,
    clearSelection,
    selectedCount,
  } = useMediaSelection();

  // Fetch all libraries for "Add to Library" action
  const { libraries } = useLibraries();

  // Dialog state
  const [addToLibraryDialogOpen, setAddToLibraryDialogOpen] = useState(false);
  const [editMetadataDialogOpen, setEditMetadataDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Snackbar state
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Fetch library data
  const { library, isLoading: libraryLoading, error: libraryError } = useLibrary(libraryId);

  // Fetch media with filters
  // Note: Not filtering by status='READY' since worker may not have processed assets yet
  // Assets show after metadata extraction (thumbnail uses originalUrl as fallback)
  const {
    media,
    isLoading: mediaLoading,
    isLoadingMore,
    error: mediaError,
    hasMore,
    loadMore,
    refresh: refreshMedia,
  } = useMedia({
    libraryId,
    mediaType: filters.mediaType === 'all' ? undefined : filters.mediaType,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  // Find current media index for lightbox
  const selectedMediaIndex = useMemo(() => {
    if (!selectedMediaId) return -1;
    return media.findIndex((m) => m.id === selectedMediaId);
  }, [media, selectedMediaId]);

  const handleMediaClick = (mediaId: string) => {
    setSelectedMediaId(mediaId);
  };

  const handleLightboxClose = () => {
    setSelectedMediaId(null);
  };

  const handleLightboxNavigate = (mediaId: string) => {
    setSelectedMediaId(mediaId);
  };

  const handleFilterChange = (newFilters: FilterState) => {
    setFilters(newFilters);
  };

  const handleUploadComplete = () => {
    void refreshMedia();
  };

  const handleBackClick = () => {
    navigate('/libraries');
  };

  // Loading state for library
  if (libraryLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Error state for library
  if (libraryError || !library) {
    return (
      <Box>
        <Button startIcon={<BackIcon />} onClick={handleBackClick} sx={{ mb: 2 }}>
          Back to Libraries
        </Button>
        <Alert severity="error">
          {libraryError || 'Library not found'}
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      {/* Breadcrumbs */}
      <Breadcrumbs sx={{ mb: 2 }}>
        <Link
          component="button"
          variant="body2"
          onClick={handleBackClick}
          underline="hover"
          color="inherit"
          sx={{ cursor: 'pointer' }}
        >
          Libraries
        </Link>
        <Typography variant="body2" color="text.primary">
          {library.name}
        </Typography>
      </Breadcrumbs>

      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          mb: 3,
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Typography variant="h4" component="h1">
              {library.name}
            </Typography>
            <Chip
              icon={getVisibilityIcon(library.visibility)}
              label={library.visibility.charAt(0).toUpperCase() + library.visibility.slice(1)}
              size="small"
              variant="outlined"
            />
          </Box>
          {library.description && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {library.description}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            {library.assetCount ?? 0} {(library.assetCount ?? 0) === 1 ? 'item' : 'items'}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<UploadIcon />}
          onClick={() => setUploadDialogOpen(true)}
        >
          Upload
        </Button>
      </Box>

      {/* Error state for media */}
      {mediaError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => void refreshMedia()}>
          {mediaError}
        </Alert>
      )}

      {/* Filters */}
      <GalleryFilters filters={filters} onFilterChange={handleFilterChange} />

      {/* Media grid */}
      <MediaGrid
        media={media}
        isLoading={mediaLoading}
        onMediaClick={handleMediaClick}
        onUploadClick={() => setUploadDialogOpen(true)}
      />

      {/* Load more button */}
      {hasMore && !mediaLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Button
            variant="outlined"
            onClick={() => void loadMore()}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1 }} />
                Loading...
              </>
            ) : (
              'Load More'
            )}
          </Button>
        </Box>
      )}

      {/* Lightbox */}
      {selectedMediaId && selectedMediaIndex >= 0 && (
        <MediaLightbox
          media={media}
          selectedIndex={selectedMediaIndex}
          onClose={handleLightboxClose}
          onNavigate={handleLightboxNavigate}
        />
      )}

      {/* Upload dialog */}
      <UploadDialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        libraryId={library.id}
        libraryName={library.name}
        onUploadComplete={handleUploadComplete}
      />
    </Box>
  );
}
