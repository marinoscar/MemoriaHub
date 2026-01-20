import { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Snackbar,
} from '@mui/material';
import { useAllMedia } from '../hooks/useAllMedia';
import { useLibraries, useMediaSelection } from '../hooks';
import { GalleryFilters, MediaLightbox, type FilterState } from '../components/gallery';
import { SelectableMediaGrid } from '../components/gallery/SelectableMediaGrid';
import { BulkActionsToolbar } from '../components/gallery/BulkActionsToolbar';
import { UploadButton } from '../components/upload/UploadButton';
import { BulkMetadataDialog, type BulkMetadataUpdate } from '../components/dialogs/BulkMetadataDialog';
import { AddToLibraryDialog } from '../components/dialogs/AddToLibraryDialog';
import { BulkDeleteDialog } from '../components/dialogs/BulkDeleteDialog';
import { mediaApi } from '../services/api/media.api';
import { libraryApi } from '../services/api/library.api';

/**
 * All Media page - landing page showing all accessible media
 * Shows media owned by user, shared with user, or in libraries user can access
 */
export function AllMediaPage() {
  // Filter state
  const [filters, setFilters] = useState<FilterState>({
    mediaType: 'all',
    sortBy: 'capturedAt',
    sortOrder: 'desc',
  });

  // Lightbox state
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);

  // Selection state
  const {
    selectedIds,
    toggleSelection,
    clearSelection,
    selectedCount,
  } = useMediaSelection();

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

  // Fetch all accessible media with filters
  const {
    media,
    isLoading: mediaLoading,
    isLoadingMore,
    error: mediaError,
    hasMore,
    total,
    loadMore,
    refresh: refreshMedia,
  } = useAllMedia({
    mediaType: filters.mediaType === 'all' ? undefined : filters.mediaType,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  // Fetch libraries for upload button
  const { libraries } = useLibraries();

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

  const handleMediaUpdate = useCallback(() => {
    // Refresh media to get updated data
    void refreshMedia();
  }, [refreshMedia]);

  const handleFilterChange = (newFilters: FilterState) => {
    setFilters(newFilters);
  };

  const handleUploadComplete = () => {
    void refreshMedia();
  };

  const handleAddToLibrary = async (libraryId: string) => {
    try {
      const assetIds: string[] = Array.from(selectedIds);
      await libraryApi.addAssets(libraryId, assetIds);
      setSnackbar({
        open: true,
        message: `Added ${assetIds.length} items to library`,
        severity: 'success',
      });
      clearSelection();
      void refreshMedia();
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'Failed to add to library',
        severity: 'error',
      });
    }
  };

  const handleEditMetadata = async (metadata: BulkMetadataUpdate) => {
    try {
      const assetIds: string[] = Array.from(selectedIds);
      const updates = assetIds.map((assetId) => ({ assetId, ...metadata }));
      const result = await mediaApi.bulkUpdateMetadata({ updates });

      const successCount = result.updated.length;
      const failCount = result.failed.length;

      if (failCount === 0) {
        setSnackbar({
          open: true,
          message: `Updated ${successCount} items`,
          severity: 'success',
        });
      } else {
        setSnackbar({
          open: true,
          message: `Updated ${successCount} items, ${failCount} failed`,
          severity: 'error',
        });
      }

      clearSelection();
      void refreshMedia();
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'Failed to update metadata',
        severity: 'error',
      });
    }
  };

  const handleDelete = async () => {
    try {
      const assetIds: string[] = Array.from(selectedIds);
      const result = await mediaApi.bulkDelete({ assetIds });

      const successCount = result.deleted.length;
      const failCount = result.failed.length;

      if (failCount === 0) {
        setSnackbar({
          open: true,
          message: `Deleted ${successCount} items`,
          severity: 'success',
        });
      } else {
        setSnackbar({
          open: true,
          message: `Deleted ${successCount} items, ${failCount} failed`,
          severity: 'error',
        });
      }

      clearSelection();
      void refreshMedia();
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'Failed to delete items',
        severity: 'error',
      });
    }
  };

  return (
    <Box>
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
          <Typography variant="h4" component="h1" gutterBottom>
            All Media
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {total} {total === 1 ? 'item' : 'items'}
          </Typography>
        </Box>
        <UploadButton
          libraries={libraries}
          variant="button"
          onUploadComplete={handleUploadComplete}
          onLibraryCreated={() => {}}
        />
      </Box>

      {/* Error state */}
      {mediaError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => void refreshMedia()}>
          {mediaError}
        </Alert>
      )}

      {/* Filters */}
      <GalleryFilters filters={filters} onFilterChange={handleFilterChange} />

      {/* Media grid with selection */}
      <SelectableMediaGrid
        media={media}
        isLoading={mediaLoading}
        selectedIds={selectedIds}
        onMediaClick={handleMediaClick}
        onToggleSelection={toggleSelection}
        onUploadClick={() => {}}
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
          onMediaUpdate={handleMediaUpdate}
        />
      )}

      {/* Bulk actions toolbar */}
      <BulkActionsToolbar
        selectedCount={selectedCount}
        onClose={clearSelection}
        onAddToLibrary={() => setAddToLibraryDialogOpen(true)}
        onEditMetadata={() => setEditMetadataDialogOpen(true)}
        onDelete={() => setDeleteDialogOpen(true)}
      />

      {/* Bulk operation dialogs */}
      <AddToLibraryDialog
        open={addToLibraryDialogOpen}
        selectedCount={selectedCount}
        libraries={libraries}
        onClose={() => setAddToLibraryDialogOpen(false)}
        onAdd={handleAddToLibrary}
      />

      <BulkMetadataDialog
        open={editMetadataDialogOpen}
        selectedCount={selectedCount}
        onClose={() => setEditMetadataDialogOpen(false)}
        onApply={handleEditMetadata}
      />

      <BulkDeleteDialog
        open={deleteDialogOpen}
        selectedCount={selectedCount}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDelete}
      />

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        message={snackbar.message}
      />
    </Box>
  );
}
