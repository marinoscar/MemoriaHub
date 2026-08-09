// ---------------------------------------------------------------------------
// MemoryAlbumDialogs — save-as-album, and share-via-album (epic #300, #313)
//
// WHY SHARING IS ALBUM CHAINING
// -----------------------------
// A memory has no public share target: `ShareTargetType` is `media_item |
// album`, and extending it would mean a new enum value, a new public renderer
// and a new unauthenticated read path. The epic defers all of that to v2 and
// ships the CAPABILITY today by chaining what already exists — save the memory
// as an album (`POST /api/memories/:id/save-album`), then hand that album id to
// the very same `ShareDialog`/`SharePanel` the album page uses. The user lands
// directly on the copy-public-link step, and nothing about the sharing
// subsystem had to change.
//
// The one thing this owes the user is HONESTY: sharing silently creates a
// visible album in their library. The dialog says so before the link appears,
// rather than leaving them to discover an album they did not ask for.
//
// ONE COMPONENT, THREE CALL SITES
// -------------------------------
// The hub, the detail page and the story player all need exactly this pair of
// dialogs plus the save-then-share sequencing. Each keeps a single
// `MemoryAlbumMode | null` state and renders this; the alternative — copying
// two dialogs, a loading flag and an error path into three files — is how the
// three surfaces would end up with three different behaviours.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material';

import { ShareDialog } from '../share/ShareDialog';
import { saveMemoryAsAlbum } from '../../services/memories';

/** Which flow the owner asked for. `null` means neither dialog is open. */
export type MemoryAlbumMode = 'save' | 'share';

/** Album name cap, mirroring `saveMemoryAlbumSchema` (`z.string().min(1).max(256)`). */
export const MEMORY_ALBUM_NAME_MAX = 256;

export interface MemoryAlbumDialogsProps {
  mode: MemoryAlbumMode | null;
  memoryId: string;
  memoryTitle: string;
  onClose: () => void;
  /**
   * A save completed. `mode` says which flow produced it, so the owner can show
   * "Saved as an album" for a deliberate save and stay quiet for the silent
   * save that only exists to make a share possible.
   */
  onSaved?: (albumId: string, mode: MemoryAlbumMode) => void;
}

export function MemoryAlbumDialogs({
  mode,
  memoryId,
  memoryTitle,
  onClose,
  onSaved,
}: MemoryAlbumDialogsProps) {
  const [name, setName] = useState(memoryTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareAlbumId, setShareAlbumId] = useState<string | null>(null);

  // Re-seed the field every time the save dialog opens. Keeping the previous
  // edit would silently name a DIFFERENT memory's album after the last one.
  useEffect(() => {
    if (mode === 'save') {
      setName(memoryTitle);
      setError(null);
    }
    if (mode === null) {
      setShareAlbumId(null);
      setError(null);
    }
  }, [mode, memoryTitle, memoryId]);

  const save = useCallback(
    async (albumName: string | undefined, flow: MemoryAlbumMode) => {
      setSaving(true);
      setError(null);
      try {
        const result = await saveMemoryAsAlbum(memoryId, albumName);
        onSaved?.(result.albumId, flow);
        return result.albumId;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not create the album',
        );
        return null;
      } finally {
        setSaving(false);
      }
    },
    [memoryId, onSaved],
  );

  // Share is a two-step flow whose first step needs no input, so it starts as
  // soon as the mode is entered rather than behind a second confirmation.
  useEffect(() => {
    if (mode !== 'share' || shareAlbumId !== null || saving) return;
    let cancelled = false;
    void save(memoryTitle, 'share').then((albumId) => {
      if (!cancelled && albumId) setShareAlbumId(albumId);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the flow, not on `save`'s identity: a re-created
    // callback must not fire a second save (and a second album).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, shareAlbumId]);

  const trimmed = name.trim();
  const nameInvalid = trimmed.length === 0 || trimmed.length > MEMORY_ALBUM_NAME_MAX;

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      <Dialog
        open={mode === 'save'}
        onClose={saving ? undefined : onClose}
        maxWidth="xs"
        fullWidth
        // Above the story player, which occupies the standard modal layer.
        sx={{ zIndex: (t) => t.zIndex.modal + 2 }}
      >
        <DialogTitle>Save as album</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Creates a new album holding this memory&apos;s photos in the same order.
            The originals stay exactly where they are.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            label="Album name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !nameInvalid && !saving) {
                e.preventDefault();
                void save(trimmed, 'save').then((id) => {
                  if (id) onClose();
                });
              }
            }}
            error={trimmed.length > MEMORY_ALBUM_NAME_MAX}
            helperText={
              trimmed.length > MEMORY_ALBUM_NAME_MAX
                ? `Album names are limited to ${MEMORY_ALBUM_NAME_MAX} characters.`
                : ' '
            }
            slotProps={{ htmlInput: { maxLength: MEMORY_ALBUM_NAME_MAX + 1 } }}
            disabled={saving}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={saving || nameInvalid}
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
            onClick={() =>
              void save(trimmed, 'save').then((id) => {
                if (id) onClose();
              })
            }
          >
            Save album
          </Button>
        </DialogActions>
      </Dialog>

      {/* ----------------------------------------------------------------
          Share, step 1: creating the album. A dialog rather than a spinner
          overlay, so the explanation of what is about to exist in the user's
          library is on screen before the album does. */}
      <Dialog
        open={mode === 'share' && shareAlbumId === null}
        onClose={saving ? undefined : onClose}
        maxWidth="xs"
        fullWidth
        sx={{ zIndex: (t) => t.zIndex.modal + 2 }}
      >
        <DialogTitle>Share this memory</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Memories are shared as an album: MemoriaHub is creating one called
            “{memoryTitle}” from this memory&apos;s photos, and the next step gives
            you a public link to it.
          </DialogContentText>
          {saving && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            {error ? 'Close' : 'Cancel'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Share, step 2: the existing album share flow, unmodified. */}
      {shareAlbumId && (
        <ShareDialog
          open={mode === 'share'}
          onClose={onClose}
          target={{ type: 'album', id: shareAlbumId }}
        />
      )}
    </>
  );
}
