import { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import {
  Close as CloseIcon,
  SelectAll as SelectAllIcon,
  Archive as ArchiveIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import type { GroupResolveAction } from '../../services/bursts';

interface GroupBulkResolveToolbarProps {
  selectedIds: Set<string>;
  onClear: () => void;
  /**
   * Select ALL pending groups across every page. May be async (the page fetches
   * the full id set), so a spinner is shown on the button while it resolves.
   */
  onSelectAll: () => void | Promise<void>;
  /** Resolve the selected groups. Parent clears selection + refreshes on success. */
  onResolve: (action: GroupResolveAction) => Promise<void>;
  /** When false, the "Resolve & Delete" (trash) action is hidden. */
  canTrash: boolean;
}

// Selections larger than this prompt a confirm dialog even for the archive action.
const LARGE_SELECTION_THRESHOLD = 25;

/**
 * Sticky bulk-resolve bar for the burst and duplicate review queues.
 * Mirrors the media BulkActionToolbar. The trash action always confirms;
 * the archive action confirms only for large selections.
 */
export function GroupBulkResolveToolbar({
  selectedIds,
  onClear,
  onSelectAll,
  onResolve,
  canTrash,
}: GroupBulkResolveToolbarProps) {
  const [loading, setLoading] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [confirmAction, setConfirmAction] = useState<GroupResolveAction | null>(null);

  const count = selectedIds.size;
  if (count === 0) return null;

  const runResolve = async (action: GroupResolveAction) => {
    setLoading(true);
    try {
      await onResolve(action);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAll = async () => {
    setSelectingAll(true);
    try {
      await onSelectAll();
    } finally {
      setSelectingAll(false);
    }
  };

  const handleClick = (action: GroupResolveAction) => {
    // Always confirm trashing; confirm archiving only for large selections.
    if (action === 'trash' || count > LARGE_SELECTION_THRESHOLD) {
      setConfirmAction(action);
    } else {
      void runResolve(action);
    }
  };

  const handleConfirm = () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (action) void runResolve(action);
  };

  const isTrash = confirmAction === 'trash';

  return (
    <>
      <Box
        sx={{
          position: 'sticky',
          top: 64,
          zIndex: (theme) => theme.zIndex.appBar + 2,
          mb: 1.5,
          px: { xs: 1, sm: 2 },
          py: 1,
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderRadius: 2,
          boxShadow: 3,
        }}
      >
        {/* Left cluster */}
        <Tooltip title="Cancel selection">
          <IconButton aria-label="Cancel selection" onClick={onClear} disabled={loading}>
            <CloseIcon />
          </IconButton>
        </Tooltip>

        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'primary.main' }}>
          {count} selected
        </Typography>

        {/* Spacer */}
        <Box sx={{ flexGrow: 1 }} />

        {/* Right cluster */}
        <Tooltip title="Select all pending (all pages)">
          <span>
            <IconButton
              aria-label="Select all pending"
              onClick={() => void handleSelectAll()}
              disabled={loading || selectingAll}
            >
              {selectingAll ? <CircularProgress size={20} /> : <SelectAllIcon />}
            </IconButton>
          </span>
        </Tooltip>

        <Button
          variant="contained"
          color="primary"
          size="small"
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <ArchiveIcon />}
          disabled={loading}
          onClick={() => handleClick('archive')}
        >
          Resolve &amp; Archive
        </Button>

        {canTrash && (
          <Button
            variant="contained"
            color="error"
            size="small"
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
            disabled={loading}
            onClick={() => handleClick('trash')}
          >
            Resolve &amp; Delete
          </Button>
        )}
      </Box>

      {/* Confirm dialog (always for trash; large selections for archive) */}
      <Dialog open={Boolean(confirmAction)} onClose={() => setConfirmAction(null)} maxWidth="xs" fullWidth>
        <DialogTitle>
          {isTrash ? 'Move non-kept photos to Trash?' : 'Archive non-kept photos?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            You are about to resolve <strong>{count}</strong> group{count !== 1 ? 's' : ''}. The
            suggested best photo in each group is kept and every other photo is{' '}
            {isTrash ? (
              <>
                moved to <strong>Trash</strong>. Trashed items can be restored within the retention
                window.
              </>
            ) : (
              <>
                <strong>archived</strong>. Archived items can be unarchived later.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAction(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={isTrash ? 'error' : 'primary'}
            onClick={handleConfirm}
          >
            {isTrash ? 'Move to Trash' : 'Archive'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
