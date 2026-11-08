import { api } from './api';

// ---------------------------------------------------------------------------
// Types
//
// Since RETRO-C1 (#575) the Jobs and Job Insights pages are the platform's and read the platform
// client; what is left here is the one thing the app still reads from `GET /api/admin/jobs`: the
// Location Groups page polls the rebuild job (`status` is all it uses), and "Repair missing
// thumbnails" posts to an app endpoint.
// ---------------------------------------------------------------------------

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type JobProcessedWindow = '4h' | '24h' | '7d' | '30d' | 'all';

export interface EnrichmentJobDto {
  id: string;
  type: string;
  status: JobStatus;
  reason: string;
  priority: number;
  /** What the job is about: `media_item`, `circle`, or null for a global job. */
  subjectType: string | null;
  subjectId: string | null;
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
  /** Which executor ran/claimed the job: 'server' (in-process worker), 'node' (distributed worker), or null (unclaimed). */
  executor?: 'server' | 'node' | null;
  /** ID of the worker node that claimed the job; null for server-executed or unclaimed jobs. */
  claimedByNodeId?: string | null;
  /** Summary of the worker node that claimed the job; null for server-executed or unclaimed jobs. */
  claimedByNode?: { id: string; name: string; hostname: string } | null;
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

export async function repairThumbnails(): Promise<{ jobId: string; status: string }> {
  return api.post<{ jobId: string; status: string }>('/admin/media/thumbnails/repair', {});
}
