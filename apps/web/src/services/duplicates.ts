import { api } from './api';

export type DuplicateGroupStatus = 'pending' | 'resolved' | 'dismissed';
export type DuplicateGroupKind = 'exact_variant' | 'edited' | 'similar';
export type DuplicateResolveAction = 'archive' | 'trash';

export interface DuplicateGroupSummary {
  id: string;
  status: DuplicateGroupStatus;
  kind: DuplicateGroupKind;
  mediaCount: number;
  capturedAt: string | null;
  suggestedBestItemId: string | null;
  coverThumbnailUrls: string[];
}

export interface DuplicateListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface DuplicateListResponse {
  items: DuplicateGroupSummary[];
  meta: DuplicateListMeta;
}

export interface DuplicateGroupMember {
  id: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  capturedAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  hasGps: boolean;
  contentHash: string | null;
  sharpnessScore: number | null;
  qualityScore: number | null;
  similarityToBest: number | null;
  isSuggestedBest: boolean;
}

export interface DuplicateGroupDetail {
  id: string;
  circleId: string;
  status: DuplicateGroupStatus;
  kind: DuplicateGroupKind;
  mediaCount: number;
  capturedAt: string | null;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  members: DuplicateGroupMember[];
}

export interface DuplicateResolveResult {
  removed: number;
  kept: number;
  action: DuplicateResolveAction;
  groupStatus: DuplicateGroupStatus;
}

export interface DuplicateDismissResult {
  groupStatus: DuplicateGroupStatus;
  ungrouped: number;
}

export interface DuplicateRerunResult {
  jobId: string;
  status: string;
}

export async function listDuplicateGroups(params: {
  circleId: string;
  status?: DuplicateGroupStatus;
  kind?: DuplicateGroupKind;
  page?: number;
  pageSize?: number;
}): Promise<DuplicateListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.kind) p.set('kind', params.kind);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<DuplicateListResponse>(`/media/duplicates?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

export async function getDuplicateGroup(id: string): Promise<DuplicateGroupDetail> {
  return api.get<DuplicateGroupDetail>(`/media/duplicates/${id}`);
}

export async function resolveDuplicateGroup(
  id: string,
  keepIds: string[],
  action: DuplicateResolveAction,
): Promise<DuplicateResolveResult> {
  return api.post<DuplicateResolveResult>(`/media/duplicates/${id}/resolve`, { keepIds, action });
}

export async function dismissDuplicateGroup(id: string): Promise<DuplicateDismissResult> {
  return api.post<DuplicateDismissResult>(`/media/duplicates/${id}/dismiss`);
}

export async function rerunDuplicateDetection(mediaItemId: string): Promise<DuplicateRerunResult> {
  return api.post<DuplicateRerunResult>(`/media/${mediaItemId}/duplicates/rerun`);
}
