import {
  Box,
  Paper,
  Typography,
  IconButton,
  Button,
  Divider,
  Stack,
} from '@mui/material';
import {
  Close as CloseIcon,
  LibraryAdd as AddToLibraryIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';

interface BulkActionsToolbarProps {
  /** Number of selected items */
  selectedCount: number;
  /** Handler to close/clear selection */
  onClose: () => void;
  /** Handler for add to library action */
  onAddToLibrary: () => void;
  /** Handler for edit metadata action */
  onEditMetadata: () => void;
  /** Handler for delete action */
  onDelete: () => void;
}

/**
 * Floating toolbar shown at bottom when items are selected
 * Provides bulk actions: add to library, edit metadata, delete
 */
export function BulkActionsToolbar({
  selectedCount,
  onClose,
  onAddToLibrary,
  onEditMetadata,
  onDelete,
}: BulkActionsToolbarProps) {
  if (selectedCount === 0) {
    return null;
  }

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        px: 2,
        py: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        minWidth: 400,
        maxWidth: '90vw',
        borderRadius: 2,
      }}
    >
      {/* Close button */}
      <IconButton
        size="small"
        onClick={onClose}
        aria-label="Clear selection"
        sx={{ mr: 1 }}
      >
        <CloseIcon />
      </IconButton>

      {/* Selected count */}
      <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 'fit-content' }}>
        {selectedCount} selected
      </Typography>

      <Divider orientation="vertical" flexItem />

      {/* Actions */}
      <Stack direction="row" spacing={1} sx={{ flex: 1 }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddToLibraryIcon />}
          onClick={onAddToLibrary}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Add to Library
        </Button>

        <Button
          variant="outlined"
          size="small"
          startIcon={<EditIcon />}
          onClick={onEditMetadata}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Edit Metadata
        </Button>

        <Button
          variant="outlined"
          size="small"
          color="error"
          startIcon={<DeleteIcon />}
          onClick={onDelete}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Delete
        </Button>
      </Stack>
    </Paper>
  );
}
