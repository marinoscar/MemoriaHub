import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Media Metadata Status Type.
 *
 * @stability experimental
 */
export type MediaMetadataStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed';

/**
 * Media Metadata Status Dto.
 *
 * @stability experimental
 */
export interface MediaMetadataStatusDto {
  status: MediaMetadataStatusType;
  processedAt: string | null;
  lastError: string | null;
}

/**
 * Metadata Rerun Result.
 *
 * @stability experimental
 */
export interface MetadataRerunResult {
  jobId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * rerun Media Metadata.
 *
 * @stability experimental
 */
export async function rerunMediaMetadata(mediaId: string): Promise<MetadataRerunResult> {
  return api.post<MetadataRerunResult>(`/media/${mediaId}/metadata/rerun`);
}

/**
 * get Media Metadata Status.
 *
 * @stability experimental
 */
export async function getMediaMetadataStatus(mediaId: string): Promise<MediaMetadataStatusDto> {
  return api.get<MediaMetadataStatusDto>(`/media/${mediaId}/metadata/status`);
}
