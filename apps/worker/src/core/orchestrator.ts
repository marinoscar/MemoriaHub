import type { ProcessingJobQueue } from '@memoriahub/shared';
import { workerConfig } from '../config/index.js';
import { QueuePoller } from './queue-poller.js';
import { logger, LogEventTypes } from '../infrastructure/logging/index.js';
import { checkDatabaseHealth, closePool } from '../infrastructure/database/index.js';
import { s3StorageProvider } from '../infrastructure/storage/index.js';

/**
 * Worker orchestrator - manages queue pollers and handles lifecycle
 */
export class Orchestrator {
  private readonly workerId: string;
  private readonly pollers = new Map<ProcessingJobQueue, QueuePoller>();
  private isRunning = false;
  private isShuttingDown = false;

  constructor() {
    this.workerId = workerConfig.workerId;
  }

  /**
   * Initialize and start the worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn({ eventType: 'orchestrator.already_running' }, 'Orchestrator is already running');
      return;
    }

    logger.info({
      eventType: LogEventTypes.WORKER_STARTED,
      workerId: this.workerId,
      config: {
        queues: Object.entries(workerConfig.queues).map(([name, config]) => ({
          name,
          enabled: config.enabled,
          concurrency: config.concurrency,
        })),
      },
    }, `Worker ${this.workerId} starting`);

    // Verify dependencies
    await this.verifyDependencies();

    // Create and start queue pollers
    this.createPollers();
    this.startPollers();

    this.isRunning = true;

    logger.info({
      eventType: LogEventTypes.WORKER_READY,
      workerId: this.workerId,
      activeQueues: Array.from(this.pollers.keys()),
    }, `Worker ${this.workerId} ready`);
  }

  /**
   * Gracefully stop the worker
   */
  async stop(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    logger.info({
      eventType: LogEventTypes.WORKER_STOPPING,
      workerId: this.workerId,
    }, `Worker ${this.workerId} stopping`);

    // Stop all pollers (no new jobs will be acquired)
    for (const poller of this.pollers.values()) {
      poller.stop();
    }

    // Wait for active jobs to complete (with timeout)
    const shutdownTimeout = workerConfig.shutdown.timeoutMs;
    const startTime = Date.now();

    for (const [queueName, poller] of this.pollers) {
      const remainingTime = shutdownTimeout - (Date.now() - startTime);
      if (remainingTime > 0) {
        logger.info({
          eventType: 'orchestrator.waiting_for_queue',
          queue: queueName,
          activeJobs: poller.activeJobCount,
        }, `Waiting for ${poller.activeJobCount} jobs in ${queueName}`);

        await poller.waitForCompletion(remainingTime);
      }
    }

    // Abort any remaining jobs and release them
    for (const poller of this.pollers.values()) {
      if (poller.activeJobCount > 0) {
        await poller.abortActiveJobs();
      }
    }

    // Close database pool
    await closePool();

    this.isRunning = false;
    this.isShuttingDown = false;

    logger.info({
      eventType: LogEventTypes.WORKER_STOPPED,
      workerId: this.workerId,
    }, `Worker ${this.workerId} stopped`);
  }

  /**
   * Pause all queues
   */
  pause(): void {
    for (const poller of this.pollers.values()) {
      poller.pause();
    }
  }

  /**
   * Resume all queues
   */
  resume(): void {
    for (const poller of this.pollers.values()) {
      poller.resume();
    }
  }

  /**
   * Check health of all dependencies
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; error?: string }>;
  }> {
    const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; error?: string }> = {};

    // Check database
    const dbStart = Date.now();
    try {
      const dbHealthy = await checkDatabaseHealth();
      checks.database = dbHealthy
        ? { status: 'ok', latencyMs: Date.now() - dbStart }
        : { status: 'error', error: 'Database check failed' };
    } catch (error) {
      checks.database = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    // Check S3
    const s3Start = Date.now();
    try {
      const s3Healthy = await s3StorageProvider.healthCheck();
      checks.s3 = s3Healthy
        ? { status: 'ok', latencyMs: Date.now() - s3Start }
        : { status: 'error', error: 'S3 check failed' };
    } catch (error) {
      checks.s3 = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    const healthy = Object.values(checks).every(c => c.status === 'ok');

    return { healthy, checks };
  }

  /**
   * Get status summary
   */
  getStatus(): {
    workerId: string;
    running: boolean;
    shuttingDown: boolean;
    queues: Array<{
      name: ProcessingJobQueue;
      activeJobs: number;
      maxConcurrency: number;
    }>;
  } {
    return {
      workerId: this.workerId,
      running: this.isRunning,
      shuttingDown: this.isShuttingDown,
      queues: Array.from(this.pollers.entries()).map(([name, poller]) => ({
        name,
        activeJobs: poller.activeJobCount,
        maxConcurrency: workerConfig.queues[name].concurrency,
      })),
    };
  }

  /**
   * Verify all dependencies are accessible
   */
  private async verifyDependencies(): Promise<void> {
    // Check database
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      throw new Error('Database health check failed');
    }
    logger.info({ eventType: 'orchestrator.db_healthy' }, 'Database connection verified');

    // Check S3
    const s3Healthy = await s3StorageProvider.healthCheck();
    if (!s3Healthy) {
      throw new Error('S3 health check failed');
    }
    logger.info({ eventType: 'orchestrator.s3_healthy' }, 'S3 connection verified');
  }

  /**
   * Create queue pollers for enabled queues
   */
  private createPollers(): void {
    const queueConfigs = workerConfig.queues;

    for (const [name, config] of Object.entries(queueConfigs)) {
      if (!config.enabled) {
        logger.info({
          eventType: 'orchestrator.queue_disabled',
          queue: name,
        }, `Queue ${name} is disabled`);
        continue;
      }

      const queueName = name as ProcessingJobQueue;
      const poller = new QueuePoller(queueName, config, this.workerId);
      this.pollers.set(queueName, poller);

      logger.info({
        eventType: 'orchestrator.queue_created',
        queue: name,
        concurrency: config.concurrency,
        pollIntervalMs: config.pollIntervalMs,
      }, `Queue poller created for ${name}`);
    }
  }

  /**
   * Start all queue pollers
   */
  private startPollers(): void {
    for (const poller of this.pollers.values()) {
      poller.start();
    }
  }
}

// Export singleton instance
export const orchestrator = new Orchestrator();
