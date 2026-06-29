import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box,
  CircularProgress,
  Typography,
  Dialog,
  DialogContent,
  IconButton,
} from '@mui/material';
import {
  Close as CloseIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
} from '@mui/icons-material';
import { getPublicShare, publicMediaUrl } from '../../services/publicApi';
import type { PublicShareResponse, PublicShareMediaItem } from '../../types/sharing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVideo(item: PublicShareMediaItem): boolean {
  return item.mediaType === 'video';
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

function CenteredSpinner() {
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

function UnavailableMessage() {
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
        This link is no longer available.
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Single media item viewer
// ---------------------------------------------------------------------------

interface SingleMediaViewerProps {
  token: string;
  item: PublicShareMediaItem;
}

function SingleMediaViewer({ token, item }: SingleMediaViewerProps) {
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
          src={publicMediaUrl(token, 0)}
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
        src={publicMediaUrl(token, 0)}
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
  token: string;
  items: PublicShareMediaItem[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

function AlbumLightbox({ token, items, index, onClose, onPrev, onNext }: AlbumLightboxProps) {
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
            src={publicMediaUrl(token, index)}
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
            src={publicMediaUrl(token, index)}
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
  token: string;
  item: PublicShareMediaItem;
  index: number;
  onClick: (index: number) => void;
}

function AlbumTile({ token, item, index, onClick }: AlbumTileProps) {
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
          <Box
            component="video"
            src={publicMediaUrl(token, index)}
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
          src={publicMediaUrl(token, index)}
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
  token: string;
  itemCount: number;
  items: PublicShareMediaItem[];
}

function AlbumViewer({ token, itemCount, items }: AlbumViewerProps) {
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
            token={token}
            item={item}
            index={idx}
            onClick={setLightboxIndex}
          />
        ))}
      </Box>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <AlbumLightbox
          token={token}
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

// ---------------------------------------------------------------------------
// PublicSharePage — main export
// ---------------------------------------------------------------------------

export default function PublicSharePage() {
  const { token = '' } = useParams<{ token: string }>();

  const [status, setStatus] = useState<'loading' | 'error' | 'success'>('loading');
  const [share, setShare] = useState<PublicShareResponse | null>(null);

  useEffect(() => {
    document.title = 'Shared media';
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      return;
    }

    let cancelled = false;

    getPublicShare(token)
      .then((data) => {
        if (!cancelled) {
          setShare(data);
          setStatus('success');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === 'loading') {
    return <CenteredSpinner />;
  }

  if (status === 'error' || share === null) {
    return <UnavailableMessage />;
  }

  if (share.type === 'media_item') {
    return <SingleMediaViewer token={token} item={share.media} />;
  }

  // share.type === 'album'
  return (
    <AlbumViewer token={token} itemCount={share.itemCount} items={share.items} />
  );
}
