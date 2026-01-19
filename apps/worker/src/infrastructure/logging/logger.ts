import { pino, type Logger } from 'pino';

/**
 * Log event types for structured logging
 */
export const LogEventTypes = {
  // Worker lifecycle
  WORKER_STARTED: 'worker.started',
  WORKER_READY: 'worker.ready',
  WORKER_STOPPING: 'worker.stopping',
  WORKER_STOPPED: 'worker.stopped',

  // Queue events
  QUEUE_POLLING: 'queue.polling',
  QUEUE_EMPTY: 'queue.empty',
  QUEUE_PAUSED: 'queue.paused',
  QUEUE_RESUMED: 'queue.resumed',

  // Job events
  JOB_ACQUIRED: 'job.acquired',
  JOB_STARTED: 'job.started',
  JOB_PROGRESS: 'job.progress',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_RETRYING: 'job.retrying',
  JOB_TIMEOUT: 'job.timeout',
  JOB_RELEASED: 'job.released',

  // S3 events
  S3_DOWNLOAD_STARTED: 's3.download.started',
  S3_DOWNLOAD_COMPLETED: 's3.download.completed',
  S3_DOWNLOAD_ERROR: 's3.download.error',
  S3_UPLOAD_STARTED: 's3.upload.started',
  S3_UPLOAD_COMPLETED: 's3.upload.completed',
  S3_UPLOAD_ERROR: 's3.upload.error',

  // Processor events
  PROCESSOR_STARTED: 'processor.started',
  PROCESSOR_COMPLETED: 'processor.completed',
  PROCESSOR_ERROR: 'processor.error',

  // Database events
  DB_QUERY: 'db.query',
  DB_QUERY_ERROR: 'db.query.error',
  DB_POOL_CONNECT: 'db.pool.connect',
  DB_POOL_ERROR: 'db.pool.error',
  DB_POOL_REMOVE: 'db.pool.remove',
  DB_POOL_CLOSED: 'db.pool.closed',

  // Health events
  HEALTH_CHECK: 'health.check',
  HEALTH_CHECK_FAILED: 'health.check.failed',
} as const;

/**
 * Create the base logger instance
 */
function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: 'worker',
      env: process.env.NODE_ENV || 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(process.env.NODE_ENV === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,service,env',
        },
      },
    }),
  });
}

/**
 * Main logger instance
 */
export const logger = createLogger();

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: Record<string, unknown>): Logger {
  return logger.child(context);
}

/**
 * Create a job-specific logger with traceId and jobId
 */
export function createJobLogger(jobId: string, traceId: string | null): Logger {
  return logger.child({
    jobId,
    traceId: traceId || undefined,
  });
}
