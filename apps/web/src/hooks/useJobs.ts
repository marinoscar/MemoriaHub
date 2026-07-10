import { useState, useCallback, useEffect, useRef } from 'react';
import {
  getJobStats,
  listJobs,
  retryJob as retryJobService,
  retryAllFailed as retryAllFailedService,
  resetStuck as resetStuckService,
  repairThumbnails as repairThumbnailsService,
  deleteJob as deleteJobService,
} from '../services/jobs';
import type { JobStats, EnrichmentJobDto, JobsListResponse, ListJobsParams, JobStatus } from '../services/jobs';

const POLL_INTERVAL_MS = 5000;

interface UseJobsOptions {
  autoRefresh?: boolean;
}

export interface UseJobsResult {
  // Data
  stats: JobStats | null;
  jobs: EnrichmentJobDto[];
  meta: JobsListResponse['meta'] | null;

  // State
  statsLoading: boolean;
  jobsLoading: boolean;
  statsError: string | null;
  jobsError: string | null;
  mutating: boolean;

  // Filters / pagination
  filters: ListJobsParams;
  setFilters: (filters: ListJobsParams) => void;

  // Auto-refresh
  autoRefresh: boolean;
  setAutoRefresh: (enabled: boolean) => void;

  // Actions
  refresh: () => Promise<void>;
  retryJob: (id: string) => Promise<void>;
  retryAllFailed: (type?: string) => Promise<{ retried: number }>;
  resetStuck: (olderThanMinutes?: number) => Promise<{ reset: number }>;
  repairThumbnails: () => Promise<{ jobId: string; status: string }>;
  deleteJob: (id: string) => Promise<void>;
}

export function useJobs(options: UseJobsOptions = {}): UseJobsResult {
  const [stats, setStats] = useState<JobStats | null>(null);
  const [jobs, setJobs] = useState<EnrichmentJobDto[]>([]);
  const [meta, setMeta] = useState<JobsListResponse['meta'] | null>(null);

  const [statsLoading, setStatsLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const [filters, setFilters] = useState<ListJobsParams>({ page: 1, pageSize: 20 });
  const [autoRefresh, setAutoRefresh] = useState(options.autoRefresh ?? true);

  // Keep a stable ref to current filters for use inside intervals
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const fetchStats = useCallback(async () => {
    try {
      const data = await getJobStats();
      setStats(data);
      setStatsError(null);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load job stats');
    }
  }, []);

  const fetchJobs = useCallback(async (params: ListJobsParams) => {
    try {
      const data = await listJobs(params);
      setJobs(data.items);
      setMeta(data.meta);
      setJobsError(null);
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : 'Failed to load jobs');
    }
  }, []);

  // Full explicit refresh (sets loading indicators)
  const refresh = useCallback(async () => {
    setStatsLoading(true);
    setJobsLoading(true);
    try {
      await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
    } finally {
      setStatsLoading(false);
      setJobsLoading(false);
    }
  }, [fetchStats, fetchJobs]);

  // Silent background poll (no loading spinners)
  const silentPoll = useCallback(async () => {
    await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
  }, [fetchStats, fetchJobs]);

  // Initial load
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch jobs when filters change (but don't re-run on first mount)
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    setJobsLoading(true);
    void fetchJobs(filters).finally(() => setJobsLoading(false));
  }, [filters, fetchJobs]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;

    const id = setInterval(() => {
      void silentPoll();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [autoRefresh, silentPoll]);

  // Mutations ----------------------------------------------------------------

  const retryJob = useCallback(async (id: string) => {
    setMutating(true);
    try {
      await retryJobService(id);
      await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
    } finally {
      setMutating(false);
    }
  }, [fetchStats, fetchJobs]);

  const retryAllFailed = useCallback(async (type?: string): Promise<{ retried: number }> => {
    setMutating(true);
    try {
      const result = await retryAllFailedService(type);
      await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
      return result;
    } finally {
      setMutating(false);
    }
  }, [fetchStats, fetchJobs]);

  const resetStuck = useCallback(async (olderThanMinutes?: number): Promise<{ reset: number }> => {
    setMutating(true);
    try {
      const result = await resetStuckService(olderThanMinutes);
      await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
      return result;
    } finally {
      setMutating(false);
    }
  }, [fetchStats, fetchJobs]);

  const repairThumbnails = useCallback(async (): Promise<{ jobId: string; status: string }> => {
    setMutating(true);
    try {
      const result = await repairThumbnailsService();
      await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
      return result;
    } finally {
      setMutating(false);
    }
  }, [fetchStats, fetchJobs]);

  const deleteJob = useCallback(async (id: string) => {
    setMutating(true);
    try {
      await deleteJobService(id);
      await Promise.all([fetchStats(), fetchJobs(filtersRef.current)]);
    } finally {
      setMutating(false);
    }
  }, [fetchStats, fetchJobs]);

  return {
    stats,
    jobs,
    meta,
    statsLoading,
    jobsLoading,
    statsError,
    jobsError,
    mutating,
    filters,
    setFilters,
    autoRefresh,
    setAutoRefresh,
    refresh,
    retryJob,
    retryAllFailed,
    resetStuck,
    repairThumbnails,
    deleteJob,
  };
}

// Re-export types for convenience
export type { JobStatus, EnrichmentJobDto, JobStats };
