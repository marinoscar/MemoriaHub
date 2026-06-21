import { api } from './api';

export type SimilarGroupStatus = 'pending' | 'resolved' | 'dismissed';

export interface SimilarGroupSummary {
  id: string;
  circleId: string;
  status: SimilarGroupStatus;
  mediaCount: number;
  createdAt: string;
  suggestedBestItemId: string | null;
  suggestedBestThumbnailUrl: string | null;
  coverThumbnailUrls: string[];
}

export interface SimilarListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface SimilarListResponse {
  items: SimilarGroupSummary[];
  meta: SimilarListMeta;
}

export interface SimilarGroupMember {
  id: string;
  capturedAt: string | null;
  importedAt: string;
  similarityScore: number | null;
  sharpnessScore: number | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  isSuggestedBest: boolean;
}

export interface SimilarGroupDetail {
  id: string;
  circleId: string;
  status: SimilarGroupStatus;
  mediaCount: number;
  createdAt: string;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  members: SimilarGroupMember[];
}

export interface SimilarResolveResult {
  deleted: number;
  kept: number;
  groupStatus: SimilarGroupStatus;
}

export interface SimilarDismissResult {
  groupStatus: SimilarGroupStatus;
  ungrouped: number;
}

export interface SimilarBackfillResult {
  enqueued: number;
}

export interface CircleDedupSettings {
  visualDedupEnabled: boolean;
}

export async function listSimilarGroups(params: {
  circleId: string;
  status?: SimilarGroupStatus;
  page?: number;
  pageSize?: number;
}): Promise<SimilarListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.status) p.set('status', params.status);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<{ items: SimilarGroupSummary[]; meta: SimilarListMeta }>(`/media/similar?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

export async function getSimilarGroup(id: string): Promise<SimilarGroupDetail> {
  const result = await api.get<{ data: SimilarGroupDetail }>(`/media/similar/${id}`);
  return result.data;
}

export async function resolveSimilarGroup(id: string, keepIds: string[]): Promise<SimilarResolveResult> {
  return api.post<SimilarResolveResult>(`/media/similar/${id}/resolve`, { keepIds });
}

export async function dismissSimilarGroup(id: string): Promise<SimilarDismissResult> {
  return api.post<SimilarDismissResult>(`/media/similar/${id}/dismiss`);
}

export interface SimilarBackfillOptions {
  from?: string;
  to?: string;
  force?: boolean;
}

export async function runSimilarBackfill(circleId: string, opts?: SimilarBackfillOptions): Promise<SimilarBackfillResult> {
  const body: Record<string, unknown> = { circleId };
  if (opts?.from !== undefined) body.from = opts.from;
  if (opts?.to !== undefined) body.to = opts.to;
  if (opts?.force !== undefined) body.force = opts.force;
  return api.post<SimilarBackfillResult>('/media/similar/backfill', body);
}

export async function getCircleDedupSettings(circleId: string): Promise<CircleDedupSettings> {
  return api.get<CircleDedupSettings>(`/circles/${circleId}/dedup-settings`);
}

export async function updateCircleDedupSettings(circleId: string, enabled: boolean): Promise<CircleDedupSettings> {
  return api.put<CircleDedupSettings>(`/circles/${circleId}/dedup-settings`, { enabled });
}
