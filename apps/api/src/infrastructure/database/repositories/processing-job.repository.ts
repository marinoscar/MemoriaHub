import type {
  ProcessingJob,
  ProcessingJobType,
  ProcessingJobStatus,
  ProcessingJobQueue,
  ProcessingJobResult,
} from '@memoriahub/shared';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';
import { getTraceId } from '../../logging/request-context.js';

/**
 * Database row type for processing jobs
 */
interface ProcessingJobRow {
  id: string;
  asset_id: string;
  job_type: ProcessingJobType;
  queue: ProcessingJobQueue;
  priority: number;
  payload: Record<string, unknown>;
  status: ProcessingJobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  worker_id: string | null;
  result: ProcessingJobResult | null;
  trace_id: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  next_retry_at: Date | null;
}

/**
 * Convert database row to ProcessingJob entity
 */
function rowToProcessingJob(row: ProcessingJobRow): ProcessingJob {
  return {
    id: row.id,
    assetId: row.asset_id,
    jobType: row.job_type,
    queue: row.queue || 'default',
    priority: row.priority,
    payload: row.payload || {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    workerId: row.worker_id,
    result: row.result,
    traceId: row.trace_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nextRetryAt: row.next_retry_at,
  };
}

/**
 * Input for creating a processing job
 */
export interface CreateProcessingJobInput {
  assetId: string;
  jobType: ProcessingJobType;
  queue?: ProcessingJobQueue;
  priority?: number;
  payload?: Record<string, unknown>;
  traceId?: string | null;
}

/**
 * Filters for listing processing jobs
 */
export interface ListProcessingJobsFilters {
  status?: ProcessingJobStatus;
  jobType?: ProcessingJobType;
  queue?: ProcessingJobQueue;
  assetId?: string;
  libraryId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'startedAt' | 'completedAt' | 'priority';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Processing job repository implementation
 */
export class ProcessingJobRepository {
  /**
   * Find processing job by ID
   */
  async findById(id: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      'SELECT * FROM processing_jobs WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToProcessingJob(result.rows[0]);
  }

  /**
   * Find processing jobs by asset ID
   */
  async findByAssetId(assetId: string): Promise<ProcessingJob[]> {
    const result = await query<ProcessingJobRow>(
      'SELECT * FROM processing_jobs WHERE asset_id = $1 ORDER BY created_at DESC',
      [assetId]
    );

    return result.rows.map(rowToProcessingJob);
  }

  /**
   * Create a new processing job
   */
  async create(input: CreateProcessingJobInput): Promise<ProcessingJob> {
    const traceId = input.traceId || getTraceId();
    const queue = input.queue || 'default';

    const result = await query<ProcessingJobRow>(
      `INSERT INTO processing_jobs (asset_id, job_type, queue, priority, payload, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.assetId,
        input.jobType,
        queue,
        input.priority ?? 0,
        JSON.stringify(input.payload || {}),
        traceId,
      ]
    );

    const job = rowToProcessingJob(result.rows[0]);

    logger.debug({
      eventType: 'processing_job.created',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      priority: job.priority,
      traceId,
    }, 'Processing job created');

    return job;
  }

  /**
   * Create multiple processing jobs
   */
  async createMany(inputs: CreateProcessingJobInput[]): Promise<ProcessingJob[]> {
    if (inputs.length === 0) return [];

    const traceId = getTraceId();
    const jobs: ProcessingJob[] = [];

    for (const input of inputs) {
      const job = await this.create({ ...input, traceId: input.traceId || traceId });
      jobs.push(job);
    }

    return jobs;
  }

  /**
   * Get next jobs to process (ordered by priority and creation time)
   */
  async getNextJobs(limit: number = 10): Promise<ProcessingJob[]> {
    const result = await query<ProcessingJobRow>(
      `SELECT * FROM processing_jobs
       WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    return result.rows.map(rowToProcessingJob);
  }

  /**
   * Get next jobs of a specific type
   */
  async getNextJobsByType(jobType: ProcessingJobType, limit: number = 10): Promise<ProcessingJob[]> {
    const result = await query<ProcessingJobRow>(
      `SELECT * FROM processing_jobs
       WHERE status = 'pending'
       AND job_type = $1
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [jobType, limit]
    );

    return result.rows.map(rowToProcessingJob);
  }

  /**
   * Start processing a job (assigns worker and updates status atomically)
   */
  async startProcessing(id: string, workerId?: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'processing', started_at = NOW(), attempts = attempts + 1, worker_id = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, workerId || null]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);

    logger.info({
      eventType: 'processing_job.started',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      workerId: job.workerId,
      attempt: job.attempts,
      traceId: job.traceId,
    }, `Processing job started (attempt ${job.attempts})`);

    return job;
  }

  /**
   * Mark job as completed with optional result
   */
  async complete(id: string, jobResult?: ProcessingJobResult): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'completed', completed_at = NOW(), result = $2, worker_id = NULL
       WHERE id = $1
       RETURNING *`,
      [id, jobResult ? JSON.stringify(jobResult) : null]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);
    const durationMs = job.completedAt && job.startedAt
      ? job.completedAt.getTime() - job.startedAt.getTime()
      : null;

    logger.info({
      eventType: 'processing_job.completed',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      durationMs,
      result: jobResult,
      traceId: job.traceId,
    }, 'Processing job completed');

    return job;
  }

  /**
   * Mark job as failed (will retry if attempts < maxAttempts)
   */
  async fail(id: string, errorMessage: string): Promise<ProcessingJob | null> {
    // First get the job to check attempts
    const job = await this.findById(id);
    if (!job) return null;

    const shouldRetry = job.attempts < job.maxAttempts;
    const newStatus: ProcessingJobStatus = shouldRetry ? 'pending' : 'failed';

    // Calculate exponential backoff for retry
    const retryDelayMs = shouldRetry
      ? Math.min(Math.pow(2, job.attempts) * 1000, 3600000) // Max 1 hour
      : null;
    const nextRetryAt = retryDelayMs ? new Date(Date.now() + retryDelayMs) : null;

    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = $2, last_error = $3, next_retry_at = $4, worker_id = NULL
       WHERE id = $1
       RETURNING *`,
      [id, newStatus, errorMessage, nextRetryAt]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const updatedJob = rowToProcessingJob(result.rows[0]);

    if (shouldRetry) {
      logger.warn({
        eventType: 'processing_job.retry_scheduled',
        jobId: updatedJob.id,
        assetId: updatedJob.assetId,
        jobType: updatedJob.jobType,
        attempt: updatedJob.attempts,
        maxAttempts: updatedJob.maxAttempts,
        nextRetryAt: nextRetryAt?.toISOString(),
        errorMessage,
        traceId: updatedJob.traceId,
      }, 'Processing job scheduled for retry');
    } else {
      logger.error({
        eventType: 'processing_job.failed',
        jobId: updatedJob.id,
        assetId: updatedJob.assetId,
        jobType: updatedJob.jobType,
        attempts: updatedJob.attempts,
        errorMessage,
        traceId: updatedJob.traceId,
      }, 'Processing job failed permanently');
    }

    return updatedJob;
  }

  /**
   * Cancel a job
   */
  async cancel(id: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'processing')
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);

    logger.info({
      eventType: 'processing_job.cancelled',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      traceId: job.traceId,
    }, 'Processing job cancelled');

    return job;
  }

  /**
   * Cancel all jobs for an asset
   */
  async cancelByAssetId(assetId: string): Promise<number> {
    const result = await query(
      `UPDATE processing_jobs
       SET status = 'cancelled', completed_at = NOW()
       WHERE asset_id = $1 AND status IN ('pending', 'processing')`,
      [assetId]
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.info({
        eventType: 'processing_job.bulk_cancelled',
        assetId,
        count,
        traceId: getTraceId(),
      }, `Cancelled ${count} processing jobs`);
    }

    return count;
  }

  /**
   * Get job statistics
   */
  async getStats(): Promise<{
    total: number;
    byStatus: Record<ProcessingJobStatus, number>;
    byType: Record<ProcessingJobType, number>;
  }> {
    const statusResult = await query<{ status: ProcessingJobStatus; count: string }>(
      `SELECT status, COUNT(*)::text as count
       FROM processing_jobs
       GROUP BY status`
    );

    const typeResult = await query<{ job_type: ProcessingJobType; count: string }>(
      `SELECT job_type, COUNT(*)::text as count
       FROM processing_jobs
       GROUP BY job_type`
    );

    const stats = {
      total: 0,
      byStatus: {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      } as Record<ProcessingJobStatus, number>,
      byType: {
        extract_metadata: 0,
        generate_thumbnail: 0,
        generate_preview: 0,
        reverse_geocode: 0,
        detect_faces: 0,
        detect_objects: 0,
        index_search: 0,
      } as Record<ProcessingJobType, number>,
    };

    for (const row of statusResult.rows) {
      const count = parseInt(row.count, 10);
      stats.total += count;
      stats.byStatus[row.status] = count;
    }

    for (const row of typeResult.rows) {
      stats.byType[row.job_type] = parseInt(row.count, 10);
    }

    return stats;
  }

  /**
   * Clean up old completed/failed jobs
   */
  async cleanupOldJobs(olderThanDays: number = 30): Promise<number> {
    const result = await query(
      `DELETE FROM processing_jobs
       WHERE status IN ('completed', 'failed', 'cancelled')
       AND completed_at < NOW() - INTERVAL '1 day' * $1`,
      [olderThanDays]
    );

    const deletedCount = result.rowCount ?? 0;

    if (deletedCount > 0) {
      logger.info({
        eventType: 'processing_job.cleanup',
        deletedCount,
        olderThanDays,
      }, `Cleaned up ${deletedCount} old processing jobs`);
    }

    return deletedCount;
  }

  // =========================================================================
  // Queue-based methods for worker service
  // =========================================================================

  /**
   * Get next jobs from a specific queue (for worker polling)
   * Uses FOR UPDATE SKIP LOCKED to prevent race conditions between workers
   */
  async getNextJobsByQueue(queueName: ProcessingJobQueue, limit: number = 1): Promise<ProcessingJob[]> {
    const result = await query<ProcessingJobRow>(
      `SELECT * FROM processing_jobs
       WHERE status = 'pending'
       AND queue = $1
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [queueName, limit]
    );

    return result.rows.map(rowToProcessingJob);
  }

  /**
   * Atomically acquire a job for processing
   * Combines SELECT + UPDATE in a transaction-safe way
   */
  async acquireJob(queueName: ProcessingJobQueue, workerId: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'processing', started_at = NOW(), attempts = attempts + 1, worker_id = $2
       WHERE id = (
         SELECT id FROM processing_jobs
         WHERE status = 'pending'
         AND queue = $1
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [queueName, workerId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);

    logger.info({
      eventType: 'processing_job.acquired',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      workerId,
      attempt: job.attempts,
      traceId: job.traceId,
    }, `Job acquired by worker ${workerId} (attempt ${job.attempts})`);

    return job;
  }

  /**
   * Release a job back to pending state (for graceful shutdown)
   * Resets the job so another worker can pick it up
   */
  async releaseJob(id: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'pending', started_at = NULL, worker_id = NULL, next_retry_at = NOW()
       WHERE id = $1 AND status = 'processing'
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);

    logger.info({
      eventType: 'processing_job.released',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      traceId: job.traceId,
    }, 'Processing job released back to queue');

    return job;
  }

  /**
   * Retry a failed job (resets status to pending)
   */
  async retryJob(id: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'pending', attempts = 0, last_error = NULL,
           next_retry_at = NULL, started_at = NULL, completed_at = NULL,
           worker_id = NULL, result = NULL
       WHERE id = $1 AND status IN ('failed', 'cancelled')
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);

    logger.info({
      eventType: 'processing_job.retry_requested',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      traceId: getTraceId(),
    }, 'Processing job retry requested');

    return job;
  }

  /**
   * Retry all failed jobs matching filters
   */
  async retryAllFailed(filters?: { jobType?: ProcessingJobType; queue?: ProcessingJobQueue }): Promise<number> {
    const conditions: string[] = ["status = 'failed'"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters?.jobType) {
      conditions.push(`job_type = $${paramIndex++}`);
      params.push(filters.jobType);
    }
    if (filters?.queue) {
      conditions.push(`queue = $${paramIndex++}`);
      params.push(filters.queue);
    }

    const result = await query(
      `UPDATE processing_jobs
       SET status = 'pending', attempts = 0, last_error = NULL,
           next_retry_at = NULL, started_at = NULL, completed_at = NULL,
           worker_id = NULL, result = NULL
       WHERE ${conditions.join(' AND ')}`,
      params
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.info({
        eventType: 'processing_job.bulk_retry',
        count,
        filters,
        traceId: getTraceId(),
      }, `Retried ${count} failed jobs`);
    }

    return count;
  }

  // =========================================================================
  // Admin API methods for listing and filtering jobs
  // =========================================================================

  /**
   * List jobs with filtering and pagination (for admin API)
   */
  async listJobs(
    filters: ListProcessingJobsFilters,
    pagination: PaginationOptions
  ): Promise<{ jobs: ProcessingJob[]; total: number }> {
    const {
      page = 1,
      limit = 50,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = pagination;
    const offset = (page - 1) * limit;

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`pj.status = $${paramIndex++}`);
      params.push(filters.status);
    }
    if (filters.jobType) {
      conditions.push(`pj.job_type = $${paramIndex++}`);
      params.push(filters.jobType);
    }
    if (filters.queue) {
      conditions.push(`pj.queue = $${paramIndex++}`);
      params.push(filters.queue);
    }
    if (filters.assetId) {
      conditions.push(`pj.asset_id = $${paramIndex++}`);
      params.push(filters.assetId);
    }
    if (filters.libraryId) {
      conditions.push(`la.library_id = $${paramIndex++}`);
      params.push(filters.libraryId);
    }
    if (filters.createdAfter) {
      conditions.push(`pj.created_at >= $${paramIndex++}`);
      params.push(filters.createdAfter);
    }
    if (filters.createdBefore) {
      conditions.push(`pj.created_at <= $${paramIndex++}`);
      params.push(filters.createdBefore);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort column mapping
    const sortColumnMap: Record<string, string> = {
      createdAt: 'pj.created_at',
      startedAt: 'pj.started_at',
      completedAt: 'pj.completed_at',
      priority: 'pj.priority',
    };
    const sortColumn = sortColumnMap[sortBy] || 'pj.created_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Need to join with library_assets if filtering by libraryId
    const needsJoin = filters.libraryId !== undefined;
    const fromClause = needsJoin
      ? 'FROM processing_jobs pj JOIN library_assets la ON pj.asset_id = la.asset_id'
      : 'FROM processing_jobs pj';

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count ${fromClause} ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get jobs
    const result = await query<ProcessingJobRow>(
      `SELECT pj.* ${fromClause} ${whereClause}
       ORDER BY ${sortColumn} ${order}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      jobs: result.rows.map(rowToProcessingJob),
      total,
    };
  }

  /**
   * Delete a job by ID
   */
  async deleteJob(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM processing_jobs WHERE id = $1',
      [id]
    );

    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted) {
      logger.info({
        eventType: 'processing_job.deleted',
        jobId: id,
        traceId: getTraceId(),
      }, 'Processing job deleted');
    }

    return deleted;
  }

  /**
   * Get comprehensive stats including queue breakdown
   */
  async getStatsByQueue(): Promise<{
    total: number;
    byStatus: Record<ProcessingJobStatus, number>;
    byType: Record<ProcessingJobType, number>;
    byQueue: Record<ProcessingJobQueue, Record<ProcessingJobStatus, number>>;
    processingRate: { lastHour: number; last24Hours: number };
    avgDurationMs: Record<ProcessingJobType, number>;
    failureRate: { lastHour: number; last24Hours: number };
  }> {
    // Get basic stats
    const statusResult = await query<{ status: ProcessingJobStatus; count: string }>(
      `SELECT status, COUNT(*)::text as count FROM processing_jobs GROUP BY status`
    );

    const typeResult = await query<{ job_type: ProcessingJobType; count: string }>(
      `SELECT job_type, COUNT(*)::text as count FROM processing_jobs GROUP BY job_type`
    );

    // Queue + status breakdown
    const queueStatusResult = await query<{
      queue: ProcessingJobQueue;
      status: ProcessingJobStatus;
      count: string;
    }>(
      `SELECT queue, status, COUNT(*)::text as count FROM processing_jobs GROUP BY queue, status`
    );

    // Processing rate
    const rateResult = await query<{ period: string; count: string }>(
      `SELECT 'lastHour' as period, COUNT(*)::text as count FROM processing_jobs
       WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '1 hour'
       UNION ALL
       SELECT 'last24Hours' as period, COUNT(*)::text as count FROM processing_jobs
       WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '24 hours'`
    );

    // Average duration by type
    const durationResult = await query<{ job_type: ProcessingJobType; avg_duration: string }>(
      `SELECT job_type, COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000), 0)::text as avg_duration
       FROM processing_jobs
       WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
       GROUP BY job_type`
    );

    // Failure rate
    const failureRateResult = await query<{ period: string; total: string; failed: string }>(
      `SELECT
         'lastHour' as period,
         COUNT(*)::text as total,
         COUNT(*) FILTER (WHERE status = 'failed')::text as failed
       FROM processing_jobs
       WHERE completed_at >= NOW() - INTERVAL '1 hour' AND status IN ('completed', 'failed')
       UNION ALL
       SELECT
         'last24Hours' as period,
         COUNT(*)::text as total,
         COUNT(*) FILTER (WHERE status = 'failed')::text as failed
       FROM processing_jobs
       WHERE completed_at >= NOW() - INTERVAL '24 hours' AND status IN ('completed', 'failed')`
    );

    // Build response
    const stats = {
      total: 0,
      byStatus: {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      } as Record<ProcessingJobStatus, number>,
      byType: {
        extract_metadata: 0,
        generate_thumbnail: 0,
        generate_preview: 0,
        reverse_geocode: 0,
        detect_faces: 0,
        detect_objects: 0,
        index_search: 0,
      } as Record<ProcessingJobType, number>,
      byQueue: {
        default: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
        large_files: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
        priority: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
        ai: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 },
      } as Record<ProcessingJobQueue, Record<ProcessingJobStatus, number>>,
      processingRate: { lastHour: 0, last24Hours: 0 },
      avgDurationMs: {
        extract_metadata: 0,
        generate_thumbnail: 0,
        generate_preview: 0,
        reverse_geocode: 0,
        detect_faces: 0,
        detect_objects: 0,
        index_search: 0,
      } as Record<ProcessingJobType, number>,
      failureRate: { lastHour: 0, last24Hours: 0 },
    };

    // Populate from queries
    for (const row of statusResult.rows) {
      const count = parseInt(row.count, 10);
      stats.total += count;
      stats.byStatus[row.status] = count;
    }

    for (const row of typeResult.rows) {
      stats.byType[row.job_type] = parseInt(row.count, 10);
    }

    for (const row of queueStatusResult.rows) {
      if (stats.byQueue[row.queue]) {
        stats.byQueue[row.queue][row.status] = parseInt(row.count, 10);
      }
    }

    for (const row of rateResult.rows) {
      if (row.period === 'lastHour') {
        stats.processingRate.lastHour = parseInt(row.count, 10);
      } else {
        stats.processingRate.last24Hours = parseInt(row.count, 10);
      }
    }

    for (const row of durationResult.rows) {
      stats.avgDurationMs[row.job_type] = Math.round(parseFloat(row.avg_duration));
    }

    for (const row of failureRateResult.rows) {
      const total = parseInt(row.total, 10);
      const failed = parseInt(row.failed, 10);
      const rate = total > 0 ? (failed / total) * 100 : 0;
      if (row.period === 'lastHour') {
        stats.failureRate.lastHour = Math.round(rate * 100) / 100;
      } else {
        stats.failureRate.last24Hours = Math.round(rate * 100) / 100;
      }
    }

    return stats;
  }

  /**
   * Find stuck jobs (processing for too long without a heartbeat)
   */
  async findStuckJobs(stuckAfterMinutes: number = 30): Promise<ProcessingJob[]> {
    const result = await query<ProcessingJobRow>(
      `SELECT * FROM processing_jobs
       WHERE status = 'processing'
       AND started_at < NOW() - INTERVAL '1 minute' * $1
       ORDER BY started_at ASC`,
      [stuckAfterMinutes]
    );

    return result.rows.map(rowToProcessingJob);
  }

  /**
   * Reset stuck jobs back to pending (for recovery)
   */
  async resetStuckJobs(stuckAfterMinutes: number = 30): Promise<number> {
    const result = await query(
      `UPDATE processing_jobs
       SET status = 'pending', started_at = NULL, worker_id = NULL, next_retry_at = NOW()
       WHERE status = 'processing'
       AND started_at < NOW() - INTERVAL '1 minute' * $1`,
      [stuckAfterMinutes]
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.warn({
        eventType: 'processing_job.stuck_reset',
        count,
        stuckAfterMinutes,
        traceId: getTraceId(),
      }, `Reset ${count} stuck jobs`);
    }

    return count;
  }

  /**
   * Get jobs for an asset that are complete (for checking derivative status)
   */
  async getCompletedJobTypesForAsset(assetId: string): Promise<ProcessingJobType[]> {
    const result = await query<{ job_type: ProcessingJobType }>(
      `SELECT DISTINCT job_type FROM processing_jobs
       WHERE asset_id = $1 AND status = 'completed'`,
      [assetId]
    );

    return result.rows.map(row => row.job_type);
  }
}

// Export singleton instance
export const processingJobRepository = new ProcessingJobRepository();
