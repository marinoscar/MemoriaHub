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

// ---------------------------------------------------------------------------
// Global backfill (admin)
// ---------------------------------------------------------------------------

/**
 * The answer of the global metadata backfill: jobs enqueued and circles covered.
 *
 * @stability experimental
 */
export interface GlobalBackfillResult {
  enqueued: number;
  circles: number;
}

/**
 * Enqueues metadata extraction across every circle (`POST /admin/metadata/backfill`).
 *
 * @param body - an optional `capturedAt` range and `force`.
 * @returns how many jobs were enqueued over how many circles.
 *
 * @stability experimental
 */
export async function runGlobalMetadataBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/metadata/backfill', body ?? {});
}
