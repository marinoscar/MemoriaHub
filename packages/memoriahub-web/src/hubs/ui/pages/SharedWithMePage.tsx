/**
 * `/shared` — Shared with me (RETRO-I6, #588).
 *
 * The albums and photos other people granted to the caller (a user or group
 * grant through the platform sharing slice), across every library, whatever
 * library the switcher shows. A member's own libraries are not repeated here:
 * the API lists only records the caller reaches THROUGH A GRANT
 * (`GET /api/media/shared-with-me`, `GET /api/media/albums/shared-with-me`).
 *
 * Read-only: opening an album goes to its normal page (the API's grant
 * fallback admits the caller), a photo opens in the lightbox.
 *
 * Layout note (issue #291): every grid item carries `minWidth: 0`, and there
 * is no `content-visibility` here.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Card, CardActionArea, CardContent, CardMedia, Skeleton, Typography } from '@mui/material';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import PhotoAlbumIcon from '@mui/icons-material/PhotoAlbum';

import { MediaLightbox } from '../../../viewer/ui/index.js';
import { listSharedAlbums, listSharedMedia } from '../../../media/headless/index.js';
import type { Album, MediaItem } from '../../../media/headless/index.js';

const ALBUMS_PAGE_SIZE = 50;
const MEDIA_PAGE_SIZE = 60;

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: T[]; total: number; page: number; totalPages: number };

function useSharedList<T>(fetcher: (page: number) => Promise<{ items: T[]; meta: { totalItems: number; totalPages: number } }>) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetcher(1)
      .then((r) => {
        if (!cancelled) setState({ status: 'ready', items: r.items, total: r.meta.totalItems, page: 1, totalPages: r.meta.totalPages });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  const loadMore = useCallback(async () => {
    if (state.status !== 'ready' || state.page >= state.totalPages) return;
    const next = state.page + 1;
    try {
      const r = await fetcher(next);
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', items: [...prev.items, ...r.items], total: r.meta.totalItems, page: next, totalPages: r.meta.totalPages }
          : prev,
      );
    } catch {
      setState({ status: 'error' });
    }
  }, [fetcher, state]);

  return { state, loadMore };
}

const fetchAlbums = (page: number) => listSharedAlbums({ page, pageSize: ALBUMS_PAGE_SIZE });
const fetchMedia = (page: number) => listSharedMedia({ page, pageSize: MEDIA_PAGE_SIZE });

const gridSx = {
  display: 'grid',
  gap: 1.5,
  gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))', lg: 'repeat(6, minmax(0, 1fr))' },
} as const;

function SectionSkeleton() {
  return (
    <Box sx={gridSx}>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} variant="rounded" sx={{ aspectRatio: '1 / 1', height: 'auto', minWidth: 0 }} />
      ))}
    </Box>
  );
}

function AlbumCard({ album }: { album: Album }) {
  return (
    <Card variant="outlined" sx={{ minWidth: 0 }}>
      <CardActionArea component={RouterLink} to={`/albums/${album.id}`}>
        {album.coverThumbnailUrl ? (
          <CardMedia component="img" image={album.coverThumbnailUrl} alt="" sx={{ aspectRatio: '1 / 1', objectFit: 'cover' }} />
        ) : (
          <Box sx={{ aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.hover' }}>
            <PhotoAlbumIcon sx={{ fontSize: 40, color: 'text.secondary' }} />
          </Box>
        )}
        <CardContent sx={{ py: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap>
            {album.name}
          </Typography>
          {typeof album.itemCount === 'number' && (
            <Typography variant="caption" color="text.secondary">
              {album.itemCount} {album.itemCount === 1 ? 'item' : 'items'}
            </Typography>
          )}
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

/**
 * The Shared with me page: the albums and photos other people granted to the caller, across every library; read-only.
 *
 * @stability experimental
 */
export default function SharedWithMePage() {
  const albums = useSharedList<Album>(fetchAlbums);
  const media = useSharedList<MediaItem>(fetchMedia);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const nothingShared =
    albums.state.status === 'ready' && albums.state.total === 0 && media.state.status === 'ready' && media.state.total === 0;

  return (
    <Box sx={{ px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <FolderSharedIcon sx={{ color: 'text.secondary' }} />
        <Typography variant="h5" component="h1">
          Shared with me
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Albums and photos other people shared with you, from any library.
      </Typography>

      {nothingShared ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <FolderSharedIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary">
            Nothing is shared with you yet
          </Typography>
        </Box>
      ) : (
        <>
          <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
            Albums
          </Typography>
          {albums.state.status === 'loading' && <SectionSkeleton />}
          {albums.state.status === 'error' && <Alert severity="error">Could not load the shared albums.</Alert>}
          {albums.state.status === 'ready' &&
            (albums.state.items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No shared albums.
              </Typography>
            ) : (
              <>
                <Box sx={gridSx}>
                  {albums.state.items.map((album) => (
                    <AlbumCard key={album.id} album={album} />
                  ))}
                </Box>
                {albums.state.page < albums.state.totalPages && (
                  <Button sx={{ mt: 1 }} onClick={() => void albums.loadMore()}>
                    Show more albums
                  </Button>
                )}
              </>
            ))}

          <Typography variant="h6" component="h2" sx={{ mt: 4, mb: 1.5 }}>
            Photos and videos
          </Typography>
          {media.state.status === 'loading' && <SectionSkeleton />}
          {media.state.status === 'error' && <Alert severity="error">Could not load the shared photos.</Alert>}
          {media.state.status === 'ready' &&
            (media.state.items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No shared photos or videos.
              </Typography>
            ) : (
              <>
                <Box sx={gridSx}>
                  {media.state.items.map((item, i) => (
                    <CardActionArea
                      key={item.id}
                      onClick={() => setOpenIndex(i)}
                      aria-label={`Open ${item.originalFilename ?? 'item'}`}
                      sx={{ minWidth: 0, borderRadius: 1, overflow: 'hidden' }}
                    >
                      {item.thumbnailUrl ? (
                        <Box component="img" src={item.thumbnailUrl} alt="" sx={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block' }} />
                      ) : (
                        <Box sx={{ aspectRatio: '1 / 1', bgcolor: 'action.hover' }} />
                      )}
                    </CardActionArea>
                  ))}
                </Box>
                {media.state.page < media.state.totalPages && (
                  <Button sx={{ mt: 1 }} onClick={() => void media.loadMore()}>
                    Show more
                  </Button>
                )}
                <MediaLightbox
                  items={media.state.items}
                  index={openIndex}
                  onIndexChange={setOpenIndex}
                  onClose={() => setOpenIndex(null)}
                  onOpenProperties={() => undefined}
                />
              </>
            ))}
        </>
      )}
    </Box>
  );
}
