import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaMetadataStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed';

export interface MediaMetadataStatusDto {
  status: MediaMetadataStatusType;
  processedAt: string | null;
  lastError: string | null;
}

export interface MetadataRerunResult {
  jobId: string;
  status: string;
}

export interface MetadataBackfillResult {
  enqueued: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function rerunMediaMetadata(mediaId: string): Promise<MetadataRerunResult> {
  return api.post<MetadataRerunResult>(`/media/${mediaId}/metadata/rerun`);
}

export async function getMediaMetadataStatus(mediaId: string): Promise<MediaMetadataStatusDto> {
  return api.get<MediaMetadataStatusDto>(`/media/${mediaId}/metadata/status`);
}

export async function runMetadataBackfill(
  circleId: string,
  opts?: { from?: string; to?: string; force?: boolean },
): Promise<MetadataBackfillResult> {
  return api.post<MetadataBackfillResult>('/metadata/backfill', { circleId, ...opts });
}
