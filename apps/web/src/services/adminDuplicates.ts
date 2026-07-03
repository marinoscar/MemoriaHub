import { api } from './api';

export interface DuplicateBackfillResult {
  enqueued: number;
  circles: number;
  estimatedItems: number;
}

export async function runGlobalDuplicatesBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<DuplicateBackfillResult> {
  return api.post<DuplicateBackfillResult>('/admin/duplicates/backfill', body ?? {});
}

export interface DuplicatesModelStatus {
  modelAvailable: boolean;
  modelPath: string;
  degraded: boolean;
  model: string;
}

export async function getDuplicatesStatus(): Promise<DuplicatesModelStatus> {
  return api.get<DuplicatesModelStatus>('/admin/duplicates/status');
}
