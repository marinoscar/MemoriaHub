import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type JobProcessedWindow = '4h' | '24h' | '7d' | '30d' | 'all';

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
  /** Number of pending jobs currently waiting on backoff (scheduledFor > now). */
  scheduled: number;
}

export interface EnrichmentJobDto {
  id: string;
  type: string;
  status: JobStatus;
  reason: string;
  priority: number;
  mediaItemId: string | null;
  circleId: string | null;
  attempts: number;
  lastError: string | null;
  providerKey: string | null;
  modelVersion: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Earliest time the worker will retry; non-null & in the future means backing off. */
  scheduledFor: string | null;
  /** ISO timestamp of when the job was last rate-limited; null if never. */
  rateLimitedAt: string | null;
  /** How many times the job has been rate-limited; 0 if never. */
  rateLimitHits: number;
  payload?: unknown;
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
  /** When true, returns only pending jobs currently in backoff (scheduledFor > now). */
  scheduled?: boolean;
  /** Filter jobs by activity time window. Omitted or 'all' = no time filter. */
  processedWithin?: JobProcessedWindow;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getJobStats(): Promise<JobStats> {
  return api.get<JobStats>('/admin/jobs/stats');
}

export async function listJobs(params: ListJobsParams = {}): Promise<JobsListResponse> {
  const qs = new URLSearchParams();
  if (params.scheduled) {
    // scheduled=true forces status=pending on the API side; don't send a conflicting status param
    qs.set('scheduled', 'true');
  } else if (params.status) {
    qs.set('status', params.status);
  }
  if (params.type) qs.set('type', params.type);
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));
  if (params.processedWithin && params.processedWithin !== 'all') {
    qs.set('processedWithin', params.processedWithin);
  }

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
