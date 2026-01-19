import type { Request, Response } from 'express';
import type {
  ProcessingJob,
  ProcessingJobStatus,
  ProcessingJobType,
  ProcessingJobQueue,
} from '@memoriahub/shared';
import { processingJobRepository } from '../../infrastructure/database/repositories/processing-job.repository.js';
import { NotFoundError } from '../../domain/errors/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';
import type {
  ListJobsQuery,
  CreateJobBody,
  BatchRetryBody,
} from '../validators/admin.validator.js';

/**
 * Convert ProcessingJob entity to DTO for API response
 */
function jobToDto(job: ProcessingJob) {
  return {
    id: job.id,
    assetId: job.assetId,
    jobType: job.jobType,
    queue: job.queue,
    priority: job.priority,
    payload: job.payload,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    workerId: job.workerId,
    result: job.result,
    traceId: job.traceId,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() || null,
    completedAt: job.completedAt?.toISOString() || null,
    nextRetryAt: job.nextRetryAt?.toISOString() || null,
  };
}

/**
 * Admin controller for job management
 */
export class AdminController {
  /**
   * List jobs with filtering and pagination
   * GET /api/admin/jobs
   */
  async listJobs(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ListJobsQuery;

    const filters = {
      status: query.status as ProcessingJobStatus | undefined,
      jobType: query.jobType as ProcessingJobType | undefined,
      queue: query.queue as ProcessingJobQueue | undefined,
      assetId: query.assetId,
      libraryId: query.libraryId,
      createdAfter: query.createdAfter ? new Date(query.createdAfter) : undefined,
      createdBefore: query.createdBefore ? new Date(query.createdBefore) : undefined,
    };

    const pagination = {
      page: query.page,
      limit: query.limit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    };

    const { jobs, total } = await processingJobRepository.listJobs(filters, pagination);

    res.json({
      data: jobs.map(jobToDto),
      meta: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    });
  }

  /**
   * Get job details
   * GET /api/admin/jobs/:id
   */
  async getJob(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    const job = await processingJobRepository.findById(id);

    if (!job) {
      throw new NotFoundError(`Job not found: ${id}`);
    }

    res.json({ data: jobToDto(job) });
  }

  /**
   * Create a job manually
   * POST /api/admin/jobs
   */
  async createJob(req: Request, res: Response): Promise<void> {
    const body = req.body as CreateJobBody;

    const job = await processingJobRepository.create({
      assetId: body.assetId,
      jobType: body.jobType,
      queue: body.queue,
      priority: body.priority,
      payload: body.payload,
      traceId: getTraceId(),
    });

    logger.info({
      eventType: 'admin.job.created',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      queue: job.queue,
      createdBy: req.user?.id,
      traceId: getTraceId(),
    }, 'Admin created job manually');

    res.status(201).json({ data: jobToDto(job) });
  }

  /**
   * Retry a failed job
   * POST /api/admin/jobs/:id/retry
   */
  async retryJob(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    const job = await processingJobRepository.retryJob(id);

    if (!job) {
      throw new NotFoundError(`Job not found or not in retriable state: ${id}`);
    }

    logger.info({
      eventType: 'admin.job.retried',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      retriedBy: req.user?.id,
      traceId: getTraceId(),
    }, 'Admin retried job');

    res.json({
      data: {
        ...jobToDto(job),
        message: 'Job queued for retry',
      },
    });
  }

  /**
   * Cancel a pending job
   * POST /api/admin/jobs/:id/cancel
   */
  async cancelJob(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    const job = await processingJobRepository.cancel(id);

    if (!job) {
      throw new NotFoundError(`Job not found or not cancellable: ${id}`);
    }

    logger.info({
      eventType: 'admin.job.cancelled',
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      cancelledBy: req.user?.id,
      traceId: getTraceId(),
    }, 'Admin cancelled job');

    res.json({
      data: {
        ...jobToDto(job),
        message: 'Job cancelled',
      },
    });
  }

  /**
   * Delete a job
   * DELETE /api/admin/jobs/:id
   */
  async deleteJob(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    const deleted = await processingJobRepository.deleteJob(id);

    if (!deleted) {
      throw new NotFoundError(`Job not found: ${id}`);
    }

    logger.info({
      eventType: 'admin.job.deleted',
      jobId: id,
      deletedBy: req.user?.id,
      traceId: getTraceId(),
    }, 'Admin deleted job');

    res.status(204).send();
  }

  /**
   * Batch retry jobs
   * POST /api/admin/jobs/batch/retry
   */
  async batchRetry(req: Request, res: Response): Promise<void> {
    const body = req.body as BatchRetryBody;

    let count = 0;

    if (body.jobIds && body.jobIds.length > 0) {
      // Retry specific jobs
      for (const jobId of body.jobIds) {
        const job = await processingJobRepository.retryJob(jobId);
        if (job) count++;
      }
    } else if (body.filters) {
      // Retry all failed jobs matching filters
      count = await processingJobRepository.retryAllFailed(body.filters);
    } else {
      // Retry all failed jobs
      count = await processingJobRepository.retryAllFailed();
    }

    logger.info({
      eventType: 'admin.jobs.batch_retried',
      count,
      filters: body.filters,
      jobIds: body.jobIds,
      retriedBy: req.user?.id,
      traceId: getTraceId(),
    }, `Admin batch retried ${count} jobs`);

    res.json({
      data: {
        retriedCount: count,
        message: `${count} job(s) queued for retry`,
      },
    });
  }

  /**
   * Get job statistics
   * GET /api/admin/jobs/stats
   */
  async getStats(_req: Request, res: Response): Promise<void> {
    const stats = await processingJobRepository.getStatsByQueue();

    res.json({ data: stats });
  }

  /**
   * Get basic stats (simpler version)
   * GET /api/admin/jobs/stats/summary
   */
  async getStatsSummary(_req: Request, res: Response): Promise<void> {
    const stats = await processingJobRepository.getStats();

    res.json({ data: stats });
  }

  /**
   * Find stuck jobs
   * GET /api/admin/jobs/stuck
   */
  async findStuckJobs(req: Request, res: Response): Promise<void> {
    const minutes = parseInt(req.query.minutes as string) || 30;

    const jobs = await processingJobRepository.findStuckJobs(minutes);

    res.json({
      data: jobs.map(jobToDto),
      meta: {
        stuckAfterMinutes: minutes,
        count: jobs.length,
      },
    });
  }

  /**
   * Reset stuck jobs
   * POST /api/admin/jobs/stuck/reset
   */
  async resetStuckJobs(req: Request, res: Response): Promise<void> {
    const minutes = parseInt(req.query.minutes as string) || 30;

    const count = await processingJobRepository.resetStuckJobs(minutes);

    logger.info({
      eventType: 'admin.jobs.stuck_reset',
      count,
      stuckAfterMinutes: minutes,
      resetBy: req.user?.id,
      traceId: getTraceId(),
    }, `Admin reset ${count} stuck jobs`);

    res.json({
      data: {
        resetCount: count,
        message: `${count} stuck job(s) reset to pending`,
      },
    });
  }
}

// Export singleton instance
export const adminController = new AdminController();
