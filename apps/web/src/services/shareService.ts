import { api } from './api';
import type {
  MediaShare,
  ShareStatus,
  ShareTargetType,
  CreateShareRequest,
  UpdateShareRequest,
  BulkShareRequest,
} from '../types/sharing';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ShareListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ShareListResponse {
  items: MediaShare[];
  meta: ShareListMeta;
}

// ---------------------------------------------------------------------------
// Share service functions
// ---------------------------------------------------------------------------

export async function createShare(req: CreateShareRequest): Promise<MediaShare> {
  return api.post<MediaShare>('/shares', req);
}

export async function listShares(params?: {
  scope?: 'mine' | 'all';
  status?: ShareStatus;
  targetType?: ShareTargetType;
  page?: number;
  pageSize?: number;
}): Promise<ShareListResponse> {
  const searchParams = new URLSearchParams();

  if (params?.scope) searchParams.set('scope', params.scope);
  if (params?.status) searchParams.set('status', params.status);
  if (params?.targetType) searchParams.set('targetType', params.targetType);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));

  const qs = searchParams.toString();
  return api.get<ShareListResponse>(`/shares${qs ? `?${qs}` : ''}`);
}

export async function updateShare(id: string, req: UpdateShareRequest): Promise<MediaShare> {
  return api.patch<MediaShare>(`/shares/${id}`, req);
}

export async function revokeShare(id: string): Promise<void> {
  await api.delete<void>(`/shares/${id}/revoke`);
}

export async function bulkShares(req: BulkShareRequest): Promise<{ affected: number }> {
  return api.post<{ affected: number }>('/shares/bulk', req);
}
