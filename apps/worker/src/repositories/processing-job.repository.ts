import type {
  ProcessingJob,
  ProcessingJobType,
  ProcessingJobStatus,
  ProcessingJobQueue,
  ProcessingJobResult,
} from '@memoriahub/shared';
import { query } from '../infrastructure/database/index.js';
import { logger, LogEventTypes } from '../infrastructure/logging/index.js';

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
 * Worker-focused processing job repository
 * Contains only the methods needed for job processing
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
   * Atomically acquire a job for processing from a specific queue
   * Uses FOR UPDATE SKIP LOCKED to prevent race conditions
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
      eventType: LogEventTypes.JOB_ACQUIRED,
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      workerId,
      attempt: job.attempts,
      traceId: job.traceId,
    }, `Job acquired by worker (attempt ${job.attempts})`);

    return job;
  }

  /**
   * Mark job as completed with result
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
      eventType: LogEventTypes.JOB_COMPLETED,
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

    // Calculate exponential backoff: min(30 * 2^(attempts-1) seconds, 1 hour)
    const retryDelayMs = shouldRetry
      ? Math.min(30000 * Math.pow(2, job.attempts - 1), 3600000)
      : null;
    const nextRetryAt = retryDelayMs ? new Date(Date.now() + retryDelayMs) : null;

    const result = await query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = $2, last_error = $3, next_retry_at = $4, worker_id = NULL,
           completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END
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
        eventType: LogEventTypes.JOB_RETRYING,
        jobId: updatedJob.id,
        assetId: updatedJob.assetId,
        jobType: updatedJob.jobType,
        queue: updatedJob.queue,
        attempt: updatedJob.attempts,
        maxAttempts: updatedJob.maxAttempts,
        nextRetryAt: nextRetryAt?.toISOString(),
        errorMessage,
        traceId: updatedJob.traceId,
      }, 'Job scheduled for retry');
    } else {
      logger.error({
        eventType: LogEventTypes.JOB_FAILED,
        jobId: updatedJob.id,
        assetId: updatedJob.assetId,
        jobType: updatedJob.jobType,
        queue: updatedJob.queue,
        attempts: updatedJob.attempts,
        errorMessage,
        traceId: updatedJob.traceId,
      }, 'Job failed permanently');
    }

    return updatedJob;
  }

  /**
   * Release a job back to pending (for graceful shutdown)
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
      eventType: LogEventTypes.JOB_RELEASED,
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      traceId: job.traceId,
    }, 'Job released back to queue');

    return job;
  }

  /**
   * Get count of pending jobs in a queue
   */
  async getPendingCount(queueName: ProcessingJobQueue): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM processing_jobs
       WHERE status = 'pending' AND queue = $1
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())`,
      [queueName]
    );

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get completed job types for an asset (to check if derivatives are ready)
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
