import type { ProcessingJobType, ProcessingJobResult } from '@memoriahub/shared';
import type { JobContext } from './job-context.js';
import { logger, LogEventTypes } from '../infrastructure/logging/index.js';

/**
 * Job handler interface that all handlers must implement
 */
export interface JobHandler {
  /** The job type this handler processes */
  readonly jobType: ProcessingJobType;

  /**
   * Process a job
   * @param context Job execution context
   * @returns Result to store with the completed job
   * @throws Error if processing fails
   */
  process(context: JobContext): Promise<ProcessingJobResult>;
}

/**
 * Job router - routes jobs to their appropriate handlers
 */
export class JobRouter {
  private handlers = new Map<ProcessingJobType, JobHandler>();

  /**
   * Register a handler for a job type
   */
  register(handler: JobHandler): void {
    if (this.handlers.has(handler.jobType)) {
      logger.warn({
        eventType: 'job_router.handler_replaced',
        jobType: handler.jobType,
      }, `Handler for ${handler.jobType} replaced`);
    }

    this.handlers.set(handler.jobType, handler);
    logger.info({
      eventType: 'job_router.handler_registered',
      jobType: handler.jobType,
    }, `Handler registered for ${handler.jobType}`);
  }

  /**
   * Get handler for a job type
   */
  getHandler(jobType: ProcessingJobType): JobHandler | undefined {
    return this.handlers.get(jobType);
  }

  /**
   * Check if a handler is registered for a job type
   */
  hasHandler(jobType: ProcessingJobType): boolean {
    return this.handlers.has(jobType);
  }

  /**
   * Route a job to its handler and process it
   */
  async route(context: JobContext): Promise<ProcessingJobResult> {
    const { job } = context;
    const handler = this.handlers.get(job.jobType);

    if (!handler) {
      throw new Error(`No handler registered for job type: ${job.jobType}`);
    }

    context.logger.info({
      eventType: LogEventTypes.JOB_STARTED,
      jobType: job.jobType,
      assetId: job.assetId,
    }, `Processing ${job.jobType}`);

    const result = await handler.process(context);

    context.logger.info({
      eventType: LogEventTypes.JOB_COMPLETED,
      jobType: job.jobType,
      assetId: job.assetId,
      durationMs: context.getElapsedMs(),
    }, `Completed ${job.jobType}`);

    return result;
  }

  /**
   * Get all registered job types
   */
  getRegisteredTypes(): ProcessingJobType[] {
    return Array.from(this.handlers.keys());
  }
}

// Export singleton instance
export const jobRouter = new JobRouter();
