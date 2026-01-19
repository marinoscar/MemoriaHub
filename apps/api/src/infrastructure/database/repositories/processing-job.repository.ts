import type { ProcessingJob, ProcessingJobType, ProcessingJobStatus } from '@memoriahub/shared';
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
  priority: number;
  payload: Record<string, unknown>;
  status: ProcessingJobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
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
    priority: row.priority,
    payload: row.payload || {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
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
  priority?: number;
  payload?: Record<string, unknown>;
  traceId?: string | null;
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

    const result = await query<ProcessingJobRow>(
      `INSERT INTO processing_jobs (asset_id, job_type, priority, payload, trace_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.assetId,
        input.jobType,
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
   * Start processing a job
   */
  async startProcessing(id: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'processing', started_at = NOW(), attempts = attempts + 1
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id]
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
      attempt: job.attempts,
      traceId: job.traceId,
    }, `Processing job started (attempt ${job.attempts})`);

    return job;
  }

  /**
   * Mark job as completed
   */
  async complete(id: string): Promise<ProcessingJob | null> {
    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const job = rowToProcessingJob(result.rows[0]);

    logger.info({
      eventType: 'processing_job.completed',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      durationMs: job.completedAt && job.startedAt
        ? job.completedAt.getTime() - job.startedAt.getTime()
        : null,
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
       SET status = $2, last_error = $3, next_retry_at = $4
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
}

// Export singleton instance
export const processingJobRepository = new ProcessingJobRepository();
