/**
 * SelectAlbumCoverDialog — pick a single album item to use as the album cover.
 *
 * Renders a thumbnail grid of the album's items, single-select, highlighting
 * the currently-selected cover. Save invokes onSave(mediaItemId); the parent
 * persists it via updateAlbum({ coverMediaItemId }).
 */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Button,
  Box,
  Grid,
  Typography,
  CircularProgress,
} from '@mui/material';
import { Close as CloseIcon, Check as CheckIcon } from '@mui/icons-material';
import type { MediaItem } from '../../types/media';

interface SelectAlbumCoverDialogProps {
  open: boolean;
  onClose: () => void;
  items: MediaItem[];
  currentCoverMediaItemId?: string | null;
  onSave: (mediaItemId: string) => Promise<void>;
}

export function SelectAlbumCoverDialog({
  open,
  onClose,
  items,
  currentCoverMediaItemId,
  onSave,
}: SelectAlbumCoverDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(currentCoverMediaItemId ?? null);
  const [saving, setSaving] = useState(false);

  // Reset the selection to the current cover whenever the dialog re-opens.
  useEffect(() => {
    if (open) setSelectedId(currentCoverMediaItemId ?? null);
  }, [open, currentCoverMediaItemId]);

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      await onSave(selectedId);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ pr: 6 }}>
        Select album cover
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={saving}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {items.length === 0 ? (
          <Box sx={{ py: 6, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              This album has no photos to choose from.
            </Typography>
          </Box>
        ) : (
          <Grid container spacing={1}>
            {items.map((item) => {
              const selected = item.id === selectedId;
              return (
                <Grid key={item.id} size={{ xs: 4, sm: 3, md: 2 }}>
                  <Box
                    onClick={() => setSelectedId(item.id)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Use ${item.originalFilename} as cover`}
                    aria-pressed={selected}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(item.id);
                      }
                    }}
                    sx={{
                      position: 'relative',
                      aspectRatio: '1 / 1',
                      cursor: 'pointer',
                      borderRadius: 1,
                      overflow: 'hidden',
                      outline: selected ? '3px solid' : '1px solid',
                      outlineColor: selected ? 'primary.main' : 'divider',
                      bgcolor: 'action.hover',
                    }}
                  >
                    {item.thumbnailUrl ? (
                      <Box
                        component="img"
                        src={item.thumbnailUrl}
                        alt={item.originalFilename}
                        loading="lazy"
                        sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    ) : (
                      <Box sx={{ width: '100%', height: '100%' }} />
                    )}
                    {selected && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          bgcolor: 'primary.main',
                          color: 'primary.contrastText',
                          borderRadius: '50%',
                          width: 24,
                          height: 24,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <CheckIcon sx={{ fontSize: 16 }} />
                      </Box>
                    )}
                  </Box>
                </Grid>
              );
            })}
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={!selectedId || saving}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
