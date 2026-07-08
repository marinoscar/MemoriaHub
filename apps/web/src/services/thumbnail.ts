import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 */
export async function rerunThumbnail(mediaId: string): Promise<ThumbnailRerunResult> {
  return api.post<ThumbnailRerunResult>(`/media/${mediaId}/thumbnail/rerun`);
}
