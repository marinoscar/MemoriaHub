/**
 * The public viewer of a shared photo, video or album (RETRO-I4, #578): the pre-platform
 * `PublicSharePage` views, ported to presigned URLs. The link renderers
 * (`MediaItemLinkRenderer`, `AlbumLinkRenderer`) fetch the view with the `X-Link-Token`
 * header and render these; every `src` is a short-lived presigned URL that carries no link
 * token, so the token never reaches a media request or its logs.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  CircularProgress,
  Typography,
  Dialog,
  DialogContent,
  IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';

/** One shared item as `GET /api/public/links/{media,album}` returns it (metadata-stripped). */
export interface PublicLinkMedia {
  mediaType: 'photo' | 'video';
  width: number | null;
  height: number | null;
  /** Presigned GET of the original (inline), or `null` when it could not be signed. */
  url: string | null;
  /** Presigned GET of the thumbnail, or `null`. */
  thumbnailUrl: string | null;
}

/** `GET /api/public/links/media`. */
export interface PublicMediaLinkView {
  type: 'media_item';
  expiresAt: string | null;
  media: PublicLinkMedia;
}

/** `GET /api/public/links/album`. */
export interface PublicAlbumLinkView {
  type: 'album';
  expiresAt: string | null;
  itemCount: number;
  items: PublicLinkMedia[];
}

type PublicShareMediaItem = PublicLinkMedia;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVideo(item: PublicShareMediaItem): boolean {
  return item.mediaType === 'video';
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

export function CenteredSpinner() {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#111',
      }}
    >
      <CircularProgress sx={{ color: 'rgba(255,255,255,0.6)' }} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Error / not-found state
// ---------------------------------------------------------------------------

export function UnavailableMessage() {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#111',
      }}
    >
      <Typography
        variant="body1"
        sx={{ color: 'rgba(255,255,255,0.5)', userSelect: 'none' }}
      >
        This link is not available
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Single media item viewer
// ---------------------------------------------------------------------------

interface SingleMediaViewerProps {
  item: PublicShareMediaItem;
}

export function SingleMediaViewer({ item }: SingleMediaViewerProps) {
  if (isVideo(item)) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100vw',
          height: '100vh',
          backgroundColor: '#111',
        }}
      >
        <Box
          component="video"
          src={item.url ?? undefined}
          controls
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
          sx={{
            maxWidth: '100vw',
            maxHeight: '100vh',
            outline: 'none',
          }}
        />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#111',
      }}
    >
      <Box
        component="img"
        src={item.url ?? undefined}
          referrerPolicy="no-referrer"
        alt=""
        draggable={false}
        onContextMenu={(e: React.MouseEvent) => e.preventDefault()}
        sx={{
          maxWidth: '100vw',
          maxHeight: '100vh',
          objectFit: 'contain',
          display: 'block',
          userSelect: 'none',
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Album lightbox dialog
// ---------------------------------------------------------------------------

interface AlbumLightboxProps {
  items: PublicShareMediaItem[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

function AlbumLightbox({ items, index, onClose, onPrev, onNext }: AlbumLightboxProps) {
  const item = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  return (
    <Dialog
      open
      onClose={onClose}
      maxWidth={false}
      fullScreen
      slotProps={{
        paper: {
          sx: {
            backgroundColor: 'rgba(0,0,0,0.95)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          },
        },
      }}
    >
      <DialogContent
        sx={{
          p: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        {/* Close */}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            color: 'rgba(255,255,255,0.8)',
            zIndex: 10,
            backgroundColor: 'rgba(0,0,0,0.4)',
            '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
          }}
        >
          <CloseIcon />
        </IconButton>

        {/* Prev */}
        {hasPrev && (
          <IconButton
            aria-label="Previous"
            onClick={onPrev}
            sx={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'rgba(255,255,255,0.8)',
              zIndex: 10,
              backgroundColor: 'rgba(0,0,0,0.4)',
              '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
            }}
          >
            <ChevronLeftIcon />
          </IconButton>
        )}

        {/* Next */}
        {hasNext && (
          <IconButton
            aria-label="Next"
            onClick={onNext}
            sx={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'rgba(255,255,255,0.8)',
              zIndex: 10,
              backgroundColor: 'rgba(0,0,0,0.4)',
              '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
            }}
          >
            <ChevronRightIcon />
          </IconButton>
        )}

        {/* Media */}
        {item && isVideo(item) ? (
          <Box
            component="video"
            key={index}
            src={item.url ?? undefined}
            controls
            controlsList="nodownload noplaybackrate"
            disablePictureInPicture
            autoPlay
            sx={{
              maxWidth: 'calc(100vw - 96px)',
              maxHeight: '100vh',
              outline: 'none',
            }}
          />
        ) : (
          <Box
            component="img"
            key={index}
            src={item.url ?? undefined}
            referrerPolicy="no-referrer"
            alt=""
            draggable={false}
            onContextMenu={(e: React.MouseEvent) => e.preventDefault()}
            sx={{
              maxWidth: 'calc(100vw - 96px)',
              maxHeight: '100vh',
              objectFit: 'contain',
              display: 'block',
              userSelect: 'none',
            }}
          />
        )}

        {/* Counter */}
        <Typography
          variant="caption"
          sx={{
            position: 'absolute',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            color: 'rgba(255,255,255,0.5)',
            userSelect: 'none',
          }}
        >
          {index + 1} / {items.length}
        </Typography>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Album grid tile
// ---------------------------------------------------------------------------

interface AlbumTileProps {
  item: PublicShareMediaItem;
  index: number;
  onClick: (index: number) => void;
}

function AlbumTile({ item, index, onClick }: AlbumTileProps) {
  return (
    <Box
      onClick={() => onClick(index)}
      sx={{
        position: 'relative',
        aspectRatio: '1',
        overflow: 'hidden',
        cursor: 'pointer',
        backgroundColor: '#222',
        '&:hover': { opacity: 0.85 },
        transition: 'opacity 0.15s',
      }}
    >
      {isVideo(item) ? (
        <>
          {item.thumbnailUrl ? (
            <Box
              component="img"
              src={item.thumbnailUrl}
              referrerPolicy="no-referrer"
              alt=""
              loading="lazy"
              draggable={false}
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
            />
          ) : (
          <Box
            component="video"
            src={item.url ?? undefined}
            muted
            preload="metadata"
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              pointerEvents: 'none',
            }}
          />
          )}
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <PlayCircleOutlinedIcon
              sx={{
                fontSize: 40,
                color: 'rgba(255,255,255,0.85)',
                filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))',
              }}
            />
          </Box>
        </>
      ) : (
        <Box
          component="img"
          src={item.thumbnailUrl ?? item.url ?? undefined}
          referrerPolicy="no-referrer"
          alt=""
          loading="lazy"
          draggable={false}
          onContextMenu={(e: React.MouseEvent) => e.preventDefault()}
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            userSelect: 'none',
          }}
        />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Album viewer
// ---------------------------------------------------------------------------

interface AlbumViewerProps {
  itemCount: number;
  items: PublicShareMediaItem[];
}

export function AlbumViewer({ itemCount, items }: AlbumViewerProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const handleClose = useCallback(() => setLightboxIndex(null), []);
  const handlePrev = useCallback(
    () => setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i)),
    [],
  );
  const handleNext = useCallback(
    () => setLightboxIndex((i) => (i !== null && i < items.length - 1 ? i + 1 : i)),
    [items.length],
  );

  return (
    <Box
      sx={{
        minHeight: '100vh',
        backgroundColor: '#111',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Neutral header */}
      <Box
        sx={{
          px: { xs: 2, md: 4 },
          py: 2,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        <Typography
          variant="subtitle1"
          sx={{ color: 'rgba(255,255,255,0.7)', fontWeight: 500, userSelect: 'none' }}
        >
          Shared album
          <Box
            component="span"
            sx={{ ml: 1.5, color: 'rgba(255,255,255,0.35)', fontWeight: 400, fontSize: '0.875rem' }}
          >
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </Box>
        </Typography>
      </Box>

      {/* Grid */}
      <Box
        sx={{
          flex: 1,
          p: { xs: '2px', sm: 1 },
          display: 'grid',
          gridTemplateColumns: {
            xs: 'repeat(3, 1fr)',
            sm: 'repeat(4, 1fr)',
            md: 'repeat(6, 1fr)',
          },
          gap: '2px',
          alignContent: 'start',
        }}
      >
        {items.map((item, idx) => (
          <AlbumTile
            key={idx}
            item={item}
            index={idx}
            onClick={setLightboxIndex}
          />
        ))}
      </Box>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <AlbumLightbox
          items={items}
          index={lightboxIndex}
          onClose={handleClose}
          onPrev={handlePrev}
          onNext={handleNext}
        />
      )}
    </Box>
  );
}
