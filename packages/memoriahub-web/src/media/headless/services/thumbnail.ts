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

/**
 * The answer of {@link repairThumbnails}: the queued job.
 *
 * @stability experimental
 */
export interface ThumbnailRepairResult {
  jobId: string;
  status: string;
}

/**
 * Queues the global thumbnail-repair sweep now instead of at the next hourly tick
 * (`POST /admin/media/thumbnails/repair`, `storage:delete_any`).
 *
 * @returns the queued job's id and status.
 *
 * @stability experimental
 */
export async function repairThumbnails(): Promise<ThumbnailRepairResult> {
  return api.post<ThumbnailRepairResult>('/admin/media/thumbnails/repair', {});
}
