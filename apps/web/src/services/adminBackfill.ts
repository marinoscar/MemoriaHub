import { api } from './api';

export interface GlobalBackfillResult {
  enqueued: number;
  circles: number;
}

export async function runGlobalTaggingBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
  /**
   * Media types to back-fill. Videos are OPT-IN (epic #452): omitting this
   * backfills photos only, so an admin's habitual backfill does not suddenly
   * dispatch an AI call for every video in the library.
   */
  mediaTypes?: ('photo' | 'video')[];
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/tagging/backfill', body ?? {});
}

export async function runGlobalBurstBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/bursts/backfill', body ?? {});
}

export async function runGlobalMetadataBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/metadata/backfill', body ?? {});
}

export async function runGlobalFaceBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/face/backfill', body ?? {});
}

export async function runGlobalFaceAutoArchiveBackfill(): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/face/auto-archive/backfill', {});
}
