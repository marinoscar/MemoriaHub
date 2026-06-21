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

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function rerunMediaTags(mediaId: string): Promise<TagRerunResult> {
  return api.post<TagRerunResult>(`/media/${mediaId}/tags/rerun`);
}

export async function getMediaTagStatus(mediaId: string): Promise<MediaTagStatusDto> {
  return api.get<MediaTagStatusDto>(`/media/${mediaId}/tags/status`);
}

