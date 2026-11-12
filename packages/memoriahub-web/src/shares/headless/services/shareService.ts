/**
 * The admin public-links page's calls (RETRO-I4, #578).
 *
 *   list     GET    /api/admin/links      (MemoriaHub, sharing:admin)
 *   re-date  PATCH  /api/grants/:id       (the sharing slice; sharing:admin may, see the API's
 *   revoke   DELETE /api/grants/:id        `share_link` bypass on the media resource types)
 *
 * Creating a link is the sharing slice's (`MediaShareDialog`, `LinkSharePanel`).
 */
import { api } from '../../../core/headless/index.js';
import type { BulkShareRequest, MediaShare, ShareStatus, ShareTargetType, UpdateShareRequest } from '../types.js';

/**
 * The paging block of a link list.
 *
 * @stability experimental
 */
export interface ShareListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * One page of links.
 *
 * @stability experimental
 */
export interface ShareListResponse {
  items: MediaShare[];
  meta: ShareListMeta;
}

/**
 * One row of `GET /api/admin/links`.
 *
 * @stability experimental
 */
export interface AdminLinkDto {
  id: string;
  resourceType: ShareTargetType;
  url: string | null;
  status: ShareStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  grantedBy: { id: string; email: string; displayName: string | null } | null;
  preview: { type: ShareTargetType; title: string | null; thumbnailUrl: string | null; itemCount?: number } | null;
}

/**
 * Maps a `GET /api/admin/links` row onto {@link MediaShare}.
 *
 * @param link - the wire row.
 * @returns the page's shape.
 *
 * @stability experimental
 */
export function toMediaShare(link: AdminLinkDto): MediaShare {
  return {
    id: link.id,
    publicUrl: link.url,
    targetType: link.resourceType,
    status: link.status,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    createdAt: link.createdAt,
    createdBy: link.grantedBy,
    ...(link.preview?.itemCount !== undefined ? { itemCount: link.preview.itemCount } : {}),
    preview: {
      thumbnailUrl: link.preview?.thumbnailUrl ?? null,
      albumName: link.resourceType === 'album' ? link.preview?.title ?? null : null,
    },
  };
}

/**
 * Lists public links (`GET /api/admin/links`, `sharing:admin`).
 *
 * @param params - status and target filters and the one-based page.
 * @returns the page of links.
 *
 * @stability experimental
 */
export async function listShares(params?: {
  status?: ShareStatus;
  targetType?: ShareTargetType;
  page?: number;
  pageSize?: number;
}): Promise<ShareListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.targetType) searchParams.set('resourceType', params.targetType);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString();
  const page = await api.get<{ items: AdminLinkDto[]; meta: ShareListMeta }>(`/admin/links${qs ? `?${qs}` : ''}`);
  return { items: page.items.map(toMediaShare), meta: page.meta };
}

/**
 * Re-dates a link (`PATCH /api/grants/:id`).
 *
 * @param id - the link grant's id.
 * @param req - the new expiry.
 *
 * @stability experimental
 */
export async function updateShare(id: string, req: UpdateShareRequest): Promise<void> {
  await api.patch<unknown>(`/grants/${id}`, { expiresAt: req.expiresAt });
}

/**
 * Revokes a link (`DELETE /api/grants/:id`).
 *
 * @param id - the link grant's id.
 *
 * @stability experimental
 */
export async function revokeShare(id: string): Promise<void> {
  await api.delete<void>(`/grants/${id}`);
}

/**
 * Applies one action to every selected link.
 *
 * @param req - the ids and the action.
 * @returns how many succeeded.
 *
 * @stability experimental
 */
export async function bulkShares(req: BulkShareRequest): Promise<{ affected: number }> {
  let affected = 0;
  for (const id of req.ids) {
    try {
      if (req.action === 'revoke') await revokeShare(id);
      else await updateShare(id, { expiresAt: req.expiresAt ?? null });
      affected += 1;
    } catch {
      // One link that fails (already revoked, gone) does not stop the rest; the count says so.
    }
  }
  return { affected };
}
