import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaTagStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed';

export interface MediaTagStatusDto {
  status: MediaTagStatusType;
  providerKey: string | null;
  modelVersion: string | null;
  tagCount: number;
  processedAt: string | null;
  lastError: string | null;
}

export interface TagRerunResult {
  jobId: string;
  status: string;
}

export interface TagBackfillResult {
  enqueued: number;
}

export interface CircleTaggingSettings {
  autoTaggingEnabled: boolean;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function rerunMediaTags(mediaId: string): Promise<TagRerunResult> {
  return api.post<TagRerunResult>(`/media/${mediaId}/tags/rerun`);
}

export async function getMediaTagStatus(mediaId: string): Promise<MediaTagStatusDto> {
  return api.get<MediaTagStatusDto>(`/media/${mediaId}/tags/status`);
}

export async function runTaggingBackfill(body: {
  circleId: string;
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<TagBackfillResult> {
  return api.post<TagBackfillResult>('/tagging/backfill', body);
}

export async function getCircleTaggingSettings(
  circleId: string,
): Promise<CircleTaggingSettings> {
  return api.get<CircleTaggingSettings>(`/circles/${circleId}/tagging-settings`);
}

export async function updateCircleTaggingSettings(
  circleId: string,
  enabled: boolean,
): Promise<CircleTaggingSettings> {
  return api.put<CircleTaggingSettings>(`/circles/${circleId}/tagging-settings`, { enabled });
}
