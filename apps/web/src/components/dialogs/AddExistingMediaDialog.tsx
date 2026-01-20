import { useState, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  CircularProgress,
  Alert,
  Checkbox,
  IconButton,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { useAllMedia } from '../../hooks/useAllMedia';
import { SelectableMediaCard } from '../gallery/SelectableMediaCard';
import { GallerySkeleton } from '../gallery/GallerySkeleton';

interface AddExistingMediaDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Library name for display */
  libraryName: string;
  /** IDs of media already in this library (to exclude from selection) */
  existingAssetIds?: Set<string>;
  /** Handler to close dialog */
  onClose: () => void;
  /** Handler when media is added */
  onAdd: (assetIds: string[]) => Promise<void>;
}

/**
 * Dialog for selecting existing media to add to a library
 * Shows a grid of all accessible media with selection checkboxes
 */
export function AddExistingMediaDialog({
  open,
  libraryName,
  existingAssetIds = new Set(),
  onClose,
  onAdd,
}: AddExistingMediaDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch all accessible media
  const {
    media,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    error: fetchError,
  } = useAllMedia({
    sortBy: 'capturedAt',
    sortOrder: 'desc',
    limit: 24,
  });

  // Filter out media already in this library
  const availableMedia = media.filter((item) => !existingAssetIds.has(item.id));

  const handleToggleSelection = useCallback((mediaId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) {
        next.delete(mediaId);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === availableMedia.length) {
      // Deselect all
      setSelectedIds(new Set());
    } else {
      // Select all available
      setSelectedIds(new Set(availableMedia.map((m) => m.id)));
    }
  }, [availableMedia, selectedIds.size]);

  const handleAdd = async () => {
    if (selectedIds.size === 0) return;

    setIsAdding(true);
    setError(null);

    try {
      await onAdd(Array.from(selectedIds));
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add media to library');
    } finally {
      setIsAdding(false);
    }
  };

  const handleClose = () => {
    setSelectedIds(new Set());
    setError(null);
    onClose();
  };

  const handleMediaClick = (mediaId: string) => {
    // In selection mode, clicking toggles selection instead of opening lightbox
    handleToggleSelection(mediaId);
  };

  const allSelected = availableMedia.length > 0 && selectedIds.size === availableMedia.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < availableMedia.length;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: { height: '80vh', maxHeight: 800 },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h6" component="span">
            Add Existing Media
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Select media to add to "{libraryName}"
          </Typography>
        </Box>
        <IconButton onClick={handleClose} aria-label="Close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 2 }}>
        {/* Error state */}
        {(fetchError || error) && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {fetchError || error}
          </Alert>
        )}

        {/* Selection header */}
        {availableMedia.length > 0 && (
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1 }}>
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={handleSelectAll}
              inputProps={{ 'aria-label': 'Select all media' }}
            />
            <Typography variant="body2" color="text.secondary">
              {selectedIds.size > 0
                ? `${selectedIds.size} selected`
                : `${availableMedia.length} available`}
            </Typography>
          </Box>
        )}

        {/* Loading state */}
        {isLoading && media.length === 0 && <GallerySkeleton />}

        {/* Empty state */}
        {!isLoading && availableMedia.length === 0 && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              py: 8,
            }}
          >
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No media available to add
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {media.length > 0
                ? 'All your media is already in this library.'
                : 'Upload some photos or videos first.'}
            </Typography>
          </Box>
        )}

        {/* Media grid */}
        {availableMedia.length > 0 && (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'repeat(2, 1fr)',
                sm: 'repeat(3, 1fr)',
                md: 'repeat(4, 1fr)',
              },
              gap: 1,
            }}
          >
            {availableMedia.map((item) => (
              <SelectableMediaCard
                key={item.id}
                media={item}
                isSelected={selectedIds.has(item.id)}
                onClick={handleMediaClick}
                onToggleSelection={handleToggleSelection}
              />
            ))}
          </Box>
        )}

        {/* Load more */}
        {hasMore && !isLoading && (
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
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={handleClose} disabled={isAdding}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleAdd}
          disabled={selectedIds.size === 0 || isAdding}
        >
          {isAdding ? (
            <>
              <CircularProgress size={20} sx={{ mr: 1 }} color="inherit" />
              Adding...
            </>
          ) : (
            `Add ${selectedIds.size > 0 ? selectedIds.size : ''} to Library`
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
