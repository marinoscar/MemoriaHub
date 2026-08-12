import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  Skeleton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import IosShareIcon from '@mui/icons-material/IosShare';
import PhotoAlbumIcon from '@mui/icons-material/PhotoAlbum';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import VideocamIcon from '@mui/icons-material/Videocam';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import {
  Link as RouterLink,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useCircleRole } from '../../hooks/useCircleRole';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { useMemory } from '../../hooks/useMemory';
import { useMemoryActions } from '../../hooks/useMemoryActions';
import { DeleteMemoryDialog } from '../../components/memories/DeleteMemoryDialog';
import { MemoryAlbumDialogs } from '../../components/memories/MemoryAlbumDialogs';
import type { MemoryAlbumMode } from '../../components/memories/MemoryAlbumDialogs';
import { MemoryStoryPlayer } from '../../components/memories/MemoryStoryPlayer';
import { formatMemoryPeriod } from '../../components/memories/memoryFormat';
import { memoryTypeMeta } from '../../components/memories/memoryTypeMeta';
import type { MemoryDetailItem } from '../../types/memories';

/**
 * `/memories/:id` — a memory's full item grid with its header, and the ONE
 * mount point for the full-screen story player (issue #313).
 *
 * Every other surface that wants playback links here with `?play=1` rather than
 * mounting a player of its own — the same single-owner pattern `AlbumPage` uses
 * for `MediaLightbox`. That keeps one place responsible for the player's props,
 * makes playback deep-linkable (the notification and the digest email can point
 * a user straight at a running story), and means the back button leaves the
 * story on the detail page instead of on whatever surface launched it.
 *
 * The `?play=1` flag is consumed once and stripped with `replace`, so a Back
 * press does not immediately relaunch the story the user just closed.
 *
 * The items are `MemoryDetailItem`s, NOT `MediaItem`s — the detail DTO returns
 * a deliberately narrow projection (id, type, dimensions, duration, signed
 * thumbnail). That is why this renders its own tile rather than reusing
 * `MediaGallery`'s: adapting the shape would mean inventing the fields the
 * gallery tile needs and cannot get, and every one of them would be a lie.
 */
export default function MemoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const enabled = useMemoriesEnabled();
  const { isCollaborator } = useCircleRole();
  const { memory, isLoading, error, notFound, patchMyState } = useMemory(
    id,
    enabled === true,
  );
  const actions = useMemoryActions({ patchMyState });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [albumMode, setAlbumMode] = useState<MemoryAlbumMode | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; albumId?: string } | null>(null);

  // Deep link: `/memories/:id?play=1` opens the story as soon as the memory has
  // loaded (there is nothing to play before that), then drops the flag.
  useEffect(() => {
    if (searchParams.get('play') !== '1') return;
    if (!memory || memory.items.length === 0) return;
    setPlayerOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('play');
    setSearchParams(next, { replace: true });
  }, [memory, searchParams, setSearchParams]);

  const handleSaved = useCallback(
    (albumId: string, mode: MemoryAlbumMode) => {
      // A share's save is a means to an end — the album is an implementation
      // detail of the link the user actually asked for, so it gets no snackbar.
      if (mode === 'save') {
        setToast({ message: 'Saved as an album', albumId });
        setAlbumMode(null);
      }
    },
    [],
  );

  const confirmDelete = useCallback(async () => {
    if (!memory) return;
    setDeleting(true);
    const ok = await actions.remove(memory.id);
    setDeleting(false);
    setDeleteOpen(false);
    // Nothing to show once the memory is a tombstone — go back to the hub.
    if (ok) navigate('/memories', { replace: true });
  }, [actions, memory, navigate]);

  if (enabled === false) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Memories are turned off for this installation.</Alert>
      </Box>
    );
  }

  if (notFound) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">
          This memory is no longer available — it may have been deleted or
          expired.{' '}
          <Link component={RouterLink} to="/memories" underline="always">
            Back to Memories
          </Link>
        </Alert>
      </Box>
    );
  }

  if (isLoading && !memory) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Skeleton variant="text" width={280} height={48} />
        <Skeleton variant="text" width={180} />
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 1,
            mt: 3,
          }}
        >
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} variant="rectangular" sx={{ aspectRatio: '1 / 1', borderRadius: 1 }} />
          ))}
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!memory) return null;

  const meta = memoryTypeMeta(memory.type);
  const period = formatMemoryPeriod(memory.periodStart, memory.periodEnd);
  const favorited = memory.myState.favorited;
  const hidden = memory.myState.hidden;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Button
        component={RouterLink}
        to="/memories"
        startIcon={<ArrowBackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        Memories
      </Button>

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ alignItems: { md: 'flex-start' }, justifyContent: 'space-between', mb: 1 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
            <Chip
              size="small"
              icon={meta.icon()}
              label={meta.label}
              variant="outlined"
              color="primary"
            />
            {period && (
              <Typography variant="body2" color="text.secondary">
                {period}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              · {memory.itemCount} {memory.itemCount === 1 ? 'item' : 'items'}
            </Typography>
            {hidden && <Chip size="small" label="Hidden for you" variant="outlined" />}
          </Stack>
          <Typography variant="h4" component="h1" sx={{ mb: 0.5 }}>
            {memory.title}
          </Typography>
          {memory.subtitle && (
            <Typography variant="subtitle1" color="text.secondary">
              {memory.subtitle}
            </Typography>
          )}
        </Box>

        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={memory.items.length === 0}
            onClick={() => setPlayerOpen(true)}
          >
            Play
          </Button>
          <Tooltip title={favorited ? 'Remove favorite' : 'Favorite'}>
            <IconButton
              aria-label={favorited ? 'Remove favorite' : 'Favorite'}
              aria-pressed={favorited}
              color={favorited ? 'error' : 'default'}
              onClick={() => void actions.setFavorite(memory.id, !favorited)}
            >
              {favorited ? <FavoriteIcon /> : <FavoriteBorderIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={hidden ? 'Unhide for me' : 'Hide for me'}>
            <IconButton
              aria-label={hidden ? 'Unhide for me' : 'Hide for me'}
              onClick={async () => {
                const ok = await actions.setHidden(memory.id, !hidden);
                if (ok) patchMyState(memory.id, { hidden: !hidden });
              }}
            >
              {hidden ? <VisibilityIcon /> : <VisibilityOffIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Save as album">
            <IconButton
              aria-label="Save as album"
              onClick={() => setAlbumMode('save')}
            >
              <PhotoAlbumIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Share — creates a shareable album from this memory">
            <IconButton aria-label="Share memory" onClick={() => setAlbumMode('share')}>
              <IosShareIcon />
            </IconButton>
          </Tooltip>
          {isCollaborator && (
            <Tooltip title="Delete for everyone">
              <IconButton
                aria-label="Delete memory"
                color="error"
                onClick={() => setDeleteOpen(true)}
              >
                <DeleteIcon />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>

      {memory.narrative && (
        <Typography
          variant="body1"
          color="text.secondary"
          sx={{ maxWidth: 720, mb: 3, mt: 1, fontStyle: 'italic' }}
        >
          {memory.narrative}
        </Typography>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 1,
          mt: 2,
        }}
      >
        {memory.items.map((item) => (
          <MemoryItemTile key={item.id} item={item} />
        ))}
      </Box>

      {memory.items.length === 0 && (
        <Alert severity="info" sx={{ mt: 2 }}>
          This memory no longer has any items — the photos in it may have been
          moved or deleted.
        </Alert>
      )}

      <MemoryStoryPlayer
        memory={memory}
        open={playerOpen}
        // The album/share dialogs render OVER the player; playback pauses while
        // one is open so the story is not running unwatched behind a modal.
        suspended={albumMode !== null}
        onClose={() => setPlayerOpen(false)}
        onSeen={actions.markSeen}
        onToggleFavorite={(next) => void actions.setFavorite(memory.id, next)}
        onSaveAsAlbum={() => setAlbumMode('save')}
        onShare={() => setAlbumMode('share')}
        onViewAllPhotos={() => setPlayerOpen(false)}
      />

      <MemoryAlbumDialogs
        mode={albumMode}
        memoryId={memory.id}
        memoryTitle={memory.title}
        onClose={() => setAlbumMode(null)}
        onSaved={handleSaved}
      />

      <DeleteMemoryDialog
        open={deleteOpen}
        memoryTitle={memory.title}
        deleting={deleting}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void confirmDelete()}
        onHideInstead={async () => {
          setDeleteOpen(false);
          const ok = await actions.setHidden(memory.id, true);
          if (ok) patchMyState(memory.id, { hidden: true });
        }}
      />

      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        message={toast?.message}
        action={
          toast?.albumId ? (
            <Button
              size="small"
              color="inherit"
              onClick={() => navigate(`/albums/${toast.albumId}`)}
            >
              View album
            </Button>
          ) : undefined
        }
      />

      <Snackbar
        open={actions.error !== null}
        autoHideDuration={6000}
        onClose={actions.clearError}
      >
        <Alert severity="error" onClose={actions.clearError} variant="filled">
          {actions.error}
        </Alert>
      </Snackbar>
    </Box>
  );
}

/** One photo/video in the memory. Square, lazy, and layout-shift free. */
function MemoryItemTile({ item }: { item: MemoryDetailItem }) {
  const isVideo = item.mediaType?.startsWith('video');
  return (
    <Box
      sx={{
        position: 'relative',
        aspectRatio: '1 / 1',
        borderRadius: 1,
        overflow: 'hidden',
        backgroundColor: 'action.hover',
      }}
    >
      {item.thumbnailUrl ? (
        <Box
          component="img"
          src={item.thumbnailUrl}
          alt=""
          loading="lazy"
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : null}
      {isVideo && (
        <VideocamIcon
          aria-label="Video"
          sx={{
            position: 'absolute',
            bottom: 4,
            right: 4,
            fontSize: 18,
            color: '#fff',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
          }}
        />
      )}
    </Box>
  );
}
