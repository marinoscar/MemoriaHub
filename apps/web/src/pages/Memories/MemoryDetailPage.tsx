import { useCallback, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Link,
  Skeleton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  DeleteOutlined as DeleteIcon,
  Favorite as FavoriteIcon,
  FavoriteBorder as FavoriteBorderIcon,
  PhotoAlbum as PhotoAlbumIcon,
  PlayArrow as PlayArrowIcon,
  Videocam as VideocamIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { useCircleRole } from '../../hooks/useCircleRole';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { useMemory } from '../../hooks/useMemory';
import { useMemoryActions } from '../../hooks/useMemoryActions';
import { DeleteMemoryDialog } from '../../components/memories/DeleteMemoryDialog';
import { formatMemoryPeriod } from '../../components/memories/memoryFormat';
import { memoryTypeMeta } from '../../components/memories/memoryTypeMeta';
import { saveMemoryAsAlbum } from '../../services/memories';
import type { MemoryDetailItem } from '../../types/memories';

/**
 * `/memories/:id` — a memory's full item grid with its header.
 *
 * This is also the click target for every card until the full-screen story
 * player lands in issue #313; "Play" on this page is that player's entry point
 * and currently opens the first item's position in this same grid.
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
  const enabled = useMemoriesEnabled();
  const { isCollaborator } = useCircleRole();
  const { memory, isLoading, error, notFound, patchMyState } = useMemory(
    id,
    enabled === true,
  );
  const actions = useMemoryActions({ patchMyState });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingAlbum, setSavingAlbum] = useState(false);
  const [toast, setToast] = useState<{ message: string; albumId?: string } | null>(null);

  const handleSaveAsAlbum = useCallback(async () => {
    if (!memory) return;
    setSavingAlbum(true);
    try {
      const result = await saveMemoryAsAlbum(memory.id);
      setToast({ message: 'Saved as an album', albumId: result.albumId });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Could not save this album',
      });
    } finally {
      setSavingAlbum(false);
    }
  }, [memory]);

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
            onClick={() => setToast({ message: 'The story player is coming soon.' })}
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
            <span>
              <IconButton
                aria-label="Save as album"
                disabled={savingAlbum}
                onClick={() => void handleSaveAsAlbum()}
              >
                {savingAlbum ? <CircularProgress size={20} /> : <PhotoAlbumIcon />}
              </IconButton>
            </span>
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
