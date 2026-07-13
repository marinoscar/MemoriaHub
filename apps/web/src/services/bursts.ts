import { api } from './api';

export type BurstGroupStatus = 'pending' | 'resolved' | 'dismissed';

/** Archive-or-trash action shared by burst and duplicate group resolution. */
export type GroupResolveAction = 'archive' | 'trash';

export interface BurstGroupSummary {
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: string | null;
  confidence: number | null;
  suggestedBestItemId: string | null;
  suggestedBestThumbnailUrl: string | null;
  coverThumbnailUrls: string[];
  createdAt: string;
}

export interface BurstListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface BurstListResponse {
  items: BurstGroupSummary[];
  meta: BurstListMeta;
}

export interface BurstGroupMember {
  id: string;
  capturedAt: string | null;
  burstScore: number | null;
  sharpnessScore: number | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  isSuggestedBest: boolean;
}

export interface BurstGroupDetail {
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: string | null;
  confidence: number | null;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  members: BurstGroupMember[];
}

export interface BurstResolveResult {
  removed: number;
  kept: number;
  action: GroupResolveAction;
  groupStatus: BurstGroupStatus;
}

export interface BurstDismissResult {
  groupStatus: BurstGroupStatus;
  ungrouped: number;
}

/** Result of a bulk resolve across many groups (shared shape with duplicates). */
export interface GroupBulkResolveResult {
  resolvedGroups: number;
  keptCount: number;
  removedCount: number;
  action: GroupResolveAction;
  skipped: number;
  errors: string[];
}

export async function listBurstGroups(params: {
  circleId: string;
  status?: BurstGroupStatus;
  page?: number;
  pageSize?: number;
}): Promise<BurstListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<{ items: BurstGroupSummary[]; meta: BurstListMeta }>(`/media/bursts?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

export async function getBurstGroup(id: string): Promise<BurstGroupDetail> {
  return api.get<BurstGroupDetail>(`/media/bursts/${id}`);
}

export async function resolveBurstGroup(
  id: string,
  keepIds: string[],
  action: GroupResolveAction,
): Promise<BurstResolveResult> {
  return api.post<BurstResolveResult>(`/media/bursts/${id}/resolve`, { keepIds, action });
}

export async function bulkResolveBurstGroups(params: {
  circleId: string;
  ids: string[];
  action: GroupResolveAction;
}): Promise<GroupBulkResolveResult> {
  return api.post<GroupBulkResolveResult>('/media/bursts/bulk/resolve', params);
}

export async function dismissBurstGroup(id: string): Promise<BurstDismissResult> {
  return api.post<BurstDismissResult>(`/media/bursts/${id}/dismiss`);
}
