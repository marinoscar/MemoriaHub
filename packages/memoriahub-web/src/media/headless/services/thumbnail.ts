import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Thumbnail Rerun Result.
 *
 * @stability experimental
 */
export interface ThumbnailRerunResult {
  status: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Re-runs thumbnail generation for a single media item. Unlike
 * rerunMediaMetadata, this runs synchronously server-side (no job to poll)
 * and resolves once the pipeline has finished, returning the resulting
 * StorageObject status ('ready' or 'failed').
 *
 * @stability experimental
 */
export async function rerunThumbnail(mediaId: string): Promise<ThumbnailRerunResult> {
  return api.post<ThumbnailRerunResult>(`/media/${mediaId}/thumbnail/rerun`);
}
