import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface JobStats {
  total: number;
  byStatus: {
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  byType: Array<{
    type: string;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    total: number;
  }>;
  stuckRunning: number;
}

export interface EnrichmentJobDto {
  id: string;
  type: string;
  status: JobStatus;
  reason: string;
  priority: number;
  mediaItemId: string;
  circleId: string;
  attempts: number;
  lastError: string | null;
  providerKey: string | null;
  modelVersion: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobsListResponse {
  items: EnrichmentJobDto[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface ListJobsParams {
  status?: JobStatus;
  type?: string;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getJobStats(): Promise<JobStats> {
  return api.get<JobStats>('/admin/jobs/stats');
}

export async function listJobs(params: ListJobsParams = {}): Promise<JobsListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.type) qs.set('type', params.type);
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));

  const query = qs.toString();
  return api.get<JobsListResponse>(`/admin/jobs${query ? `?${query}` : ''}`);
}

export async function retryJob(id: string): Promise<EnrichmentJobDto> {
  return api.post<EnrichmentJobDto>(`/admin/jobs/${id}/retry`);
}

export async function retryAllFailed(type?: string): Promise<{ retried: number }> {
  return api.post<{ retried: number }>('/admin/jobs/retry-failed', type ? { type } : {});
}

export async function resetStuck(olderThanMinutes?: number): Promise<{ reset: number }> {
  return api.post<{ reset: number }>('/admin/jobs/reset-stuck', olderThanMinutes != null ? { olderThanMinutes } : {});
}

export async function deleteJob(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/admin/jobs/${id}`);
}
