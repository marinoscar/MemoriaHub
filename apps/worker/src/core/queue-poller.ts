import type { ProcessingJob, ProcessingJobQueue } from '@memoriahub/shared';
import type { QueueConfig } from '../config/index.js';
import { processingJobRepository } from '../repositories/index.js';
import { jobRouter } from './job-router.js';
import { createJobContext } from './job-context.js';
import { logger, LogEventTypes } from '../infrastructure/logging/index.js';

/**
 * Queue poller - polls a specific queue for jobs and processes them
 */
export class QueuePoller {
  private readonly queueName: ProcessingJobQueue;
  private readonly config: QueueConfig;
  private readonly workerId: string;

  private isRunning = false;
  private isPaused = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = new Map<string, { job: ProcessingJob; abortController: AbortController }>();

  constructor(queueName: ProcessingJobQueue, config: QueueConfig, workerId: string) {
    this.queueName = queueName;
    this.config = config;
    this.workerId = workerId;
  }

  /**
   * Start polling for jobs
   */
  start(): void {
    if (this.isRunning) {
      logger.warn({
        eventType: 'queue.already_running',
        queue: this.queueName,
      }, `Queue ${this.queueName} is already running`);
      return;
    }

    this.isRunning = true;
    logger.info({
      eventType: 'queue.started',
      queue: this.queueName,
      concurrency: this.config.concurrency,
      pollIntervalMs: this.config.pollIntervalMs,
    }, `Queue poller started for ${this.queueName}`);

    this.schedulePoll();
  }

  /**
   * Stop polling for jobs
   */
  stop(): void {
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    logger.info({
      eventType: 'queue.stopped',
      queue: this.queueName,
      activeJobs: this.activeJobs.size,
    }, `Queue poller stopped for ${this.queueName}`);
  }

  /**
   * Pause job acquisition (finish current jobs but don't acquire new ones)
   */
  pause(): void {
    this.isPaused = true;
    logger.info({
      eventType: LogEventTypes.QUEUE_PAUSED,
      queue: this.queueName,
    }, `Queue ${this.queueName} paused`);
  }

  /**
   * Resume job acquisition
   */
  resume(): void {
    this.isPaused = false;
    logger.info({
      eventType: LogEventTypes.QUEUE_RESUMED,
      queue: this.queueName,
    }, `Queue ${this.queueName} resumed`);
  }

  /**
   * Get count of currently active jobs
   */
  get activeJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Check if can accept more jobs
   */
  get canAcceptJobs(): boolean {
    return this.isRunning && !this.isPaused && this.activeJobs.size < this.config.concurrency;
  }

  /**
   * Wait for all active jobs to complete
   */
  async waitForCompletion(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (this.activeJobs.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn({
          eventType: 'queue.timeout_waiting',
          queue: this.queueName,
          activeJobs: this.activeJobs.size,
        }, `Timeout waiting for ${this.activeJobs.size} jobs to complete`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Abort all active jobs and release them back to the queue
   */
  async abortActiveJobs(): Promise<void> {
    const activeJobIds = Array.from(this.activeJobs.keys());

    for (const jobId of activeJobIds) {
      const entry = this.activeJobs.get(jobId);
      if (entry) {
        // Abort the job processing
        entry.abortController.abort();

        // Release back to queue
        try {
          await processingJobRepository.releaseJob(jobId);
        } catch (error) {
          logger.error({
            eventType: 'queue.release_error',
            queue: this.queueName,
            jobId,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 'Failed to release job');
        }
      }
    }

    this.activeJobs.clear();
  }

  /**
   * Schedule next poll
   */
  private schedulePoll(): void {
    if (!this.isRunning) return;

    this.pollTimer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
  }

  /**
   * Poll for and process jobs
   */
  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Check if we can accept more jobs
      while (this.canAcceptJobs) {
        const job = await this.acquireNextJob();
        if (!job) {
          // No more jobs available
          break;
        }

        // Process job asynchronously (don't await)
        this.processJob(job);
      }
    } catch (error) {
      logger.error({
        eventType: 'queue.poll_error',
        queue: this.queueName,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Error during poll');
    }

    // Schedule next poll
    this.schedulePoll();
  }

  /**
   * Acquire next job from queue
   */
  private async acquireNextJob(): Promise<ProcessingJob | null> {
    logger.debug({
      eventType: LogEventTypes.QUEUE_POLLING,
      queue: this.queueName,
      activeJobs: this.activeJobs.size,
      maxConcurrency: this.config.concurrency,
    }, `Polling queue ${this.queueName}`);

    const job = await processingJobRepository.acquireJob(this.queueName, this.workerId);

    if (!job) {
      logger.debug({
        eventType: LogEventTypes.QUEUE_EMPTY,
        queue: this.queueName,
      }, `No pending jobs in ${this.queueName}`);
    }

    return job;
  }

  /**
   * Process a job (async - doesn't block polling)
   */
  private async processJob(job: ProcessingJob): Promise<void> {
    const abortController = new AbortController();
    this.activeJobs.set(job.id, { job, abortController });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
      logger.error({
        eventType: LogEventTypes.JOB_TIMEOUT,
        jobId: job.id,
        assetId: job.assetId,
        jobType: job.jobType,
        timeoutMs: this.config.jobTimeoutMs,
        traceId: job.traceId,
      }, `Job timed out after ${this.config.jobTimeoutMs}ms`);
    }, this.config.jobTimeoutMs);

    try {
      // Check if we have a handler for this job type
      if (!jobRouter.hasHandler(job.jobType)) {
        throw new Error(`No handler registered for job type: ${job.jobType}`);
      }

      // Create job context and route to handler
      const context = createJobContext(job, this.workerId, abortController);
      const result = await jobRouter.route(context);

      // Mark job as completed
      await processingJobRepository.complete(job.id, result);
    } catch (error) {
      // Check if aborted
      if (abortController.signal.aborted) {
        // Job was aborted (timeout or shutdown)
        await processingJobRepository.fail(job.id, 'Job aborted (timeout or shutdown)');
      } else {
        // Regular failure
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await processingJobRepository.fail(job.id, errorMessage);
      }
    } finally {
      clearTimeout(timeoutId);
      this.activeJobs.delete(job.id);
    }
  }
}
