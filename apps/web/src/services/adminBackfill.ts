import { api } from './api';

export interface GlobalBackfillResult {
  enqueued: number;
  circles: number;
}

export async function runGlobalTaggingBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
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
