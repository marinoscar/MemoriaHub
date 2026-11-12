import { api } from './api';

export interface GlobalBackfillResult {
  enqueued: number;
  circles: number;
}

export async function runGlobalMetadataBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GlobalBackfillResult> {
  return api.post<GlobalBackfillResult>('/admin/metadata/backfill', body ?? {});
}
