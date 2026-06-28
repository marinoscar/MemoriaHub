import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SocialStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed';

export interface SocialStatusDto {
  status: SocialStatusType;
  detected: boolean;
  platform: string | null;
  processedAt: string | null;
  lastError: string | null;
}

export interface SocialRerunResult {
  jobId: string;
  status: string;
}

export interface SocialDetectorsDto {
  mainTag: string;
  platforms: Array<{ key: string; tagName: string }>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getSocialStatus(mediaId: string): Promise<SocialStatusDto> {
  return api.get<SocialStatusDto>(`/media/${mediaId}/social/status`);
}

export async function rerunSocial(mediaId: string): Promise<SocialRerunResult> {
  return api.post<SocialRerunResult>(`/media/${mediaId}/social/rerun`);
}

export async function runGlobalSocialBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<{ enqueued: number; circles: number }> {
  return api.post<{ enqueued: number; circles: number }>('/admin/social/backfill', body ?? {});
}

export async function getSocialDetectors(): Promise<SocialDetectorsDto> {
  return api.get<SocialDetectorsDto>('/admin/social/detectors');
}
