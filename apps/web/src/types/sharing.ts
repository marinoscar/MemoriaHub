// ---------------------------------------------------------------------------
// Sharing — types for the public media sharing feature
// ---------------------------------------------------------------------------

export type ShareTargetType = 'media_item' | 'album';

export type ShareStatus = 'active' | 'expired' | 'revoked';

export interface MediaShare {
  id: string;
  token: string;
  publicUrl: string;
  targetType: ShareTargetType;
  status: ShareStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  itemCount?: number;
  preview?: {
    thumbnailUrl: string | null;
    albumName?: string | null;
  };
}

export interface CreateShareRequest {
  targetType: ShareTargetType;
  mediaItemId?: string;
  albumId?: string;
  expiresAt?: string | null;
}

export interface UpdateShareRequest {
  expiresAt: string | null;
}

export interface BulkShareRequest {
  ids: string[];
  action: 'revoke' | 'set_expiration' | 'delete';
  expiresAt?: string | null;
}

// ---------------------------------------------------------------------------
// Public share response (unauthenticated)
// ---------------------------------------------------------------------------

export interface PublicShareMediaItem {
  mediaType: 'photo' | 'video';
  width: number | null;
  height: number | null;
}

export interface PublicMediaShare {
  type: 'media_item';
  media: PublicShareMediaItem;
}

export interface PublicAlbumShare {
  type: 'album';
  itemCount: number;
  items: PublicShareMediaItem[];
}

export type PublicShareResponse = PublicMediaShare | PublicAlbumShare;
