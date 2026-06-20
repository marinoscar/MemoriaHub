import { api } from './api';

export type BurstGroupStatus = 'pending' | 'resolved' | 'dismissed';

export interface BurstGroupSummary {
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: string | null;
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
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  members: BurstGroupMember[];
}

export interface BurstResolveResult {
  deleted: number;
  kept: number;
  groupStatus: BurstGroupStatus;
}

export interface BurstDismissResult {
  groupStatus: BurstGroupStatus;
  ungrouped: number;
}

export interface BurstBackfillResult {
  enqueued: number;
}

export interface CircleBurstSettings {
  burstDetectionEnabled: boolean;
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
  const result = await api.get<{ data: BurstGroupSummary[]; meta: BurstListMeta }>(`/media/bursts?${p.toString()}`);
  return { items: result.data ?? [], meta: result.meta };
}

export async function getBurstGroup(id: string): Promise<BurstGroupDetail> {
  return api.get<BurstGroupDetail>(`/media/bursts/${id}`);
}

export async function resolveBurstGroup(id: string, keepIds: string[]): Promise<BurstResolveResult> {
  return api.post<BurstResolveResult>(`/media/bursts/${id}/resolve`, { keepIds });
}

export async function dismissBurstGroup(id: string): Promise<BurstDismissResult> {
  return api.post<BurstDismissResult>(`/media/bursts/${id}/dismiss`);
}

export async function runBurstBackfill(circleId: string, force?: boolean): Promise<BurstBackfillResult> {
  return api.post<BurstBackfillResult>('/media/bursts/backfill', { circleId, force });
}

export async function getCircleBurstSettings(circleId: string): Promise<CircleBurstSettings> {
  return api.get<CircleBurstSettings>(`/circles/${circleId}/burst-settings`);
}

export async function updateCircleBurstSettings(circleId: string, enabled: boolean): Promise<CircleBurstSettings> {
  return api.put<CircleBurstSettings>(`/circles/${circleId}/burst-settings`, { enabled });
}
