import { api } from './api';

export interface JobInsightsLiveByType {
  type: string;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
}

export interface JobInsightsHistoryOverall {
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  throughputPerMin: number;
}

export interface JobInsightsHistoryByType {
  type: string;
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  throughputPerMin: number;
}

export interface JobInsightsEtaPerType {
  type: string;
  remaining: number;
  avgMs: number | null;
  etcMs: number | null;
}

export interface JobLifetimeStats {
  succeeded: number;
  failed: number;
  total: number;
  avgMs: number;
  samples: number;
}

export interface JobLifetimeByType extends JobLifetimeStats {
  type: string;
}

export interface JobInsights {
  computedAt: string;
  windowDays: number;
  concurrency: number;
  live: {
    total: number;
    byStatus: { pending: number; running: number; succeeded: number; failed: number };
    pending: number;
    running: number;
    failed: number;
    scheduled: number;
    rateLimited: number;
    retried: number;
    byType: JobInsightsLiveByType[];
  };
  history: {
    overall: JobInsightsHistoryOverall;
    byType: JobInsightsHistoryByType[];
  };
  eta: {
    totalRemaining: number;
    etaMs: number | null;
    basis: 'live' | 'partial' | 'none';
    perType: JobInsightsEtaPerType[];
  };
  lifetime: {
    overall: JobLifetimeStats;
    byType: JobLifetimeByType[];
  };
}

export async function getJobInsights(windowDays?: number): Promise<JobInsights> {
  return api.get<JobInsights>('/admin/jobs/insights' + (windowDays ? '?windowDays=' + windowDays : ''));
}

export async function resetJobHistory(): Promise<{ reset: number }> {
  return api.post<{ reset: number }>('/admin/jobs/insights/reset-history');
}
