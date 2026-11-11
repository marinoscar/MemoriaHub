import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Media Tag Status Type.
 *
 * @stability experimental
 */
export type MediaTagStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed';

/**
 * Media Tag Status Dto.
 *
 * @stability experimental
 */
export interface MediaTagStatusDto {
  /** The `status`. */
  status: MediaTagStatusType;
  /** The `providerKey`. */
  providerKey: string | null;
  /** The `modelVersion`. */
  modelVersion: string | null;
  /** The `tagCount`. */
  tagCount: number;
  /** The `processedAt`. */
  processedAt: string | null;
  /** The `lastError`. */
  lastError: string | null;
}

/**
 * Tag Rerun Result.
 *
 * @stability experimental
 */
export interface TagRerunResult {
  /** The `jobId`. */
  jobId: string;
  /** The `status`. */
  status: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Rerun Media Tags.
 *
 * @stability experimental
 */
export async function rerunMediaTags(mediaId: string): Promise<TagRerunResult> {
  return api.post<TagRerunResult>(`/media/${mediaId}/tags/rerun`);
}

/**
 * Get Media Tag Status.
 *
 * @stability experimental
 */
export async function getMediaTagStatus(mediaId: string): Promise<MediaTagStatusDto> {
  return api.get<MediaTagStatusDto>(`/media/${mediaId}/tags/status`);
}

