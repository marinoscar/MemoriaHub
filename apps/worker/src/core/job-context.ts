import type { ProcessingJob } from '@memoriahub/shared';
import type { Logger } from 'pino';
import { createJobLogger } from '../infrastructure/logging/index.js';

/**
 * Job execution context
 * Provides job-specific logger and utilities during processing
 */
export interface JobContext {
  /** The job being processed */
  job: ProcessingJob;

  /** Job-specific logger with traceId */
  logger: Logger;

  /** Worker ID processing this job */
  workerId: string;

  /** Job start time */
  startTime: number;

  /** Get elapsed time in milliseconds */
  getElapsedMs(): number;

  /** Abort signal for timeout handling */
  abortSignal: AbortSignal;
}

/**
 * Create a job execution context
 */
export function createJobContext(
  job: ProcessingJob,
  workerId: string,
  abortController: AbortController
): JobContext {
  const startTime = Date.now();
  const logger = createJobLogger(job.id, job.traceId);

  return {
    job,
    logger,
    workerId,
    startTime,
    getElapsedMs: () => Date.now() - startTime,
    abortSignal: abortController.signal,
  };
}
