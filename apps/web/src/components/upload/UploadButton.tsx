import { useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Photo as PhotoIcon,
  CloudUpload as UploadIcon,
  CreateNewFolder as CreateFolderIcon,
} from '@mui/icons-material';
import type { LibraryDTO } from '@memoriahub/shared';
import { UploadDialog } from './UploadDialog';
import { CreateLibraryDialog } from '../library/CreateLibraryDialog';

interface UploadButtonProps {
  /**
   * Libraries available for upload
   */
  libraries: LibraryDTO[];
  /**
   * Currently selected library (for direct upload)
   */
  selectedLibrary?: LibraryDTO | null;
  /**
   * Variant: 'icon' for icon button, 'button' for full button
   */
  variant?: 'icon' | 'button';
  /**
   * Callback when upload is complete
   */
  onUploadComplete?: () => void;
  /**
   * Callback when library is created
   */
  onLibraryCreated?: (library: LibraryDTO) => void;
}

/**
 * Upload button with dropdown menu (Google Photos-style)
 */
export function UploadButton({
  libraries,
  selectedLibrary,
  variant = 'icon',
  onUploadComplete,
  onLibraryCreated,
}: UploadButtonProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [createLibraryDialogOpen, setCreateLibraryDialogOpen] = useState(false);
  const [uploadLibrary, setUploadLibrary] = useState<LibraryDTO | null>(null);

  const menuOpen = Boolean(anchorEl);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    // If there's a selected library, open upload dialog directly
    if (selectedLibrary) {
      setUploadLibrary(selectedLibrary);
      setUploadDialogOpen(true);
    } else if (libraries.length === 1) {
      // If only one library, upload to it directly
      setUploadLibrary(libraries[0]);
      setUploadDialogOpen(true);
    } else {
      // Show menu to choose action
      setAnchorEl(event.currentTarget);
    }
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleUploadWithoutLibrary = () => {
    handleClose();
    setUploadLibrary(null);
    setUploadDialogOpen(true);
  };

  const handleUploadToLibrary = (library: LibraryDTO) => {
    handleClose();
    setUploadLibrary(library);
    setUploadDialogOpen(true);
  };

  const handleCreateLibrary = () => {
    handleClose();
    setCreateLibraryDialogOpen(true);
  };

  const handleLibraryCreated = (library: LibraryDTO) => {
    setCreateLibraryDialogOpen(false);
    if (onLibraryCreated) {
      onLibraryCreated(library);
    }
    // Offer to upload to the new library
    setUploadLibrary(library);
    setUploadDialogOpen(true);
  };

  const handleUploadComplete = () => {
    if (onUploadComplete) {
      onUploadComplete();
    }
  };

  return (
    <>
      {variant === 'icon' ? (
        <Tooltip title="Upload">
          <IconButton
            onClick={handleClick}
            size="medium"
            aria-controls={menuOpen ? 'upload-menu' : undefined}
            aria-haspopup="true"
            aria-expanded={menuOpen ? 'true' : undefined}
            color="inherit"
          >
            <AddIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <Button
          onClick={handleClick}
          variant="contained"
          startIcon={<AddIcon />}
          aria-controls={menuOpen ? 'upload-menu' : undefined}
          aria-haspopup="true"
          aria-expanded={menuOpen ? 'true' : undefined}
        >
          Upload
        </Button>
      )}

      {/* Dropdown menu */}
      <Menu
        id="upload-menu"
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        PaperProps={{
          elevation: 3,
          sx: { minWidth: 200, mt: 1 },
        }}
      >
        {/* Upload without library (to My Media) */}
        <MenuItem onClick={handleUploadWithoutLibrary}>
          <ListItemIcon>
            <UploadIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Upload" />
        </MenuItem>

        {/* Upload to library options */}
        {libraries.length > 0 && (
          <>
            {libraries.slice(0, 5).map((library) => (
              <MenuItem key={library.id} onClick={() => handleUploadToLibrary(library)}>
                <ListItemIcon>
                  <PhotoIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={`Upload to ${library.name}`}
                  primaryTypographyProps={{ noWrap: true, sx: { maxWidth: 180 } }}
                />
              </MenuItem>
            ))}
            {libraries.length > 5 && (
              <MenuItem disabled>
                <ListItemText secondary={`+${libraries.length - 5} more libraries`} />
              </MenuItem>
            )}
          </>
        )}

        {/* Create library option */}
        <MenuItem onClick={handleCreateLibrary}>
          <ListItemIcon>
            <CreateFolderIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Create Library" />
        </MenuItem>
      </Menu>

      {/* Upload dialog */}
      <UploadDialog
        open={uploadDialogOpen}
        onClose={() => {
          setUploadDialogOpen(false);
          setUploadLibrary(null);
        }}
        libraryId={uploadLibrary?.id}
        libraryName={uploadLibrary?.name}
        onUploadComplete={handleUploadComplete}
      />

      {/* Create library dialog */}
      <CreateLibraryDialog
        open={createLibraryDialogOpen}
        onClose={() => setCreateLibraryDialogOpen(false)}
        onCreated={handleLibraryCreated}
      />
    </>
  );
}
