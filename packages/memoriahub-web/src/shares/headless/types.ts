/**
 * Public links as the admin page lists them (RETRO-I4, #578): platform link grants on a
 * photo, video or album, from `GET /api/admin/links` (`sharing:admin`). The page keeps the
 * shape it had over `media_shares` (`MediaShare`), mapped by `services/shareService.ts`.
 */

/**
 * What a public link points at.
 *
 * @stability experimental
 */
export type ShareTargetType = 'media_item' | 'album';

/**
 * A link's state.
 *
 * @stability experimental
 */
export type ShareStatus = 'active' | 'expired' | 'revoked';

/**
 * One public link as the admin page lists it.
 *
 * @stability experimental
 */
export interface MediaShare {
  /** The link grant's id (`PATCH` / `DELETE /api/grants/:id`). */
  id: string;
  /** `<APP_URL>/s#lnk_...`, re-derived by the server; `null` when it cannot be. A bearer credential. */
  publicUrl: string | null;
  targetType: ShareTargetType;
  status: ShareStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  itemCount?: number;
  createdBy?: { id: string; email: string; displayName: string | null } | null;
  preview?: {
    thumbnailUrl: string | null;
    albumName?: string | null;
  };
}

/**
 * A new expiry for a link (`null` never expires).
 *
 * @stability experimental
 */
export interface UpdateShareRequest {
  expiresAt: string | null;
}

/**
 * Revoke or re-date several links (a loop over the slice's per-grant routes; no hard delete).
 *
 * @stability experimental
 */
export interface BulkShareRequest {
  ids: string[];
  action: 'revoke' | 'set_expiration';
  expiresAt?: string | null;
}
