import { useState, useEffect } from 'react';
import { Avatar, Box } from '@mui/material';
import { Person as PersonIcon } from '@mui/icons-material';
import { FaceCrop } from './FaceCrop';
import { getMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';
import type { PersonListItem } from '../../services/face';

// ---------------------------------------------------------------------------
// Module-level dedup cache — prevents duplicate concurrent fetches when many
// PersonAvatars render simultaneously for the same mediaItemId.
// ---------------------------------------------------------------------------
const mediaCache = new Map<string, Promise<MediaItem>>();

function fetchMediaCached(id: string): Promise<MediaItem> {
  if (!mediaCache.has(id)) {
    mediaCache.set(id, getMedia(id));
  }
  return mediaCache.get(id)!;
}

// ---------------------------------------------------------------------------
// PersonAvatar
// ---------------------------------------------------------------------------

export type PersonAvatarPerson = Pick<
  PersonListItem,
  'id' | 'name' | 'coverFace' | 'profileMediaItemId' | 'profileCrop'
>;

interface PersonAvatarProps {
  person: PersonAvatarPerson;
  size?: number;
}

export function PersonAvatar({ person, size = 48 }: PersonAvatarProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // Determine which mediaItemId to fetch
  const profileMediaItemId = person.profileMediaItemId ?? null;
  const coverMediaItemId = person.coverFace?.mediaItemId ?? null;
  const targetMediaItemId = profileMediaItemId ?? coverMediaItemId;

  useEffect(() => {
    if (!targetMediaItemId) return;
    let mounted = true;

    fetchMediaCached(targetMediaItemId)
      .then((item) => {
        if (!mounted) return;
        const url = item.thumbnailUrl ?? item.downloadUrl ?? null;
        setImageUrl(url);
      })
      .catch(() => {
        // silently fall back to default avatar
      });

    return () => {
      mounted = false;
    };
  }, [targetMediaItemId]);

  // Case 1: profileMediaItemId set and URL resolved
  if (profileMediaItemId && imageUrl) {
    if (person.profileCrop) {
      // Render FaceCrop using the custom profile crop
      return (
        <FaceCrop
          imageUrl={imageUrl}
          boundingBox={person.profileCrop}
          size={size}
          sx={{ borderRadius: '50%' }}
        />
      );
    }
    // No specific crop — render full image as circle
    return (
      <Box
        component="img"
        src={imageUrl}
        alt={person.name ?? 'Person'}
        sx={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          display: 'block',
          flexShrink: 0,
        }}
      />
    );
  }

  // Case 2: coverFace set and URL resolved
  if (person.coverFace && imageUrl && !profileMediaItemId) {
    return (
      <FaceCrop
        imageUrl={imageUrl}
        boundingBox={person.coverFace.boundingBox}
        size={size}
        sx={{ borderRadius: '50%' }}
      />
    );
  }

  // Case 3: fallback — generic person avatar (also shown while loading)
  return (
    <Avatar sx={{ width: size, height: size, bgcolor: 'primary.light', flexShrink: 0 }}>
      <PersonIcon sx={{ fontSize: size * 0.5 }} />
    </Avatar>
  );
}
