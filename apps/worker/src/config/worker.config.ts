import { z } from 'zod';
import type { ProcessingJobQueue } from '@memoriahub/shared';

/**
 * Queue configuration schema
 */
const queueConfigSchema = z.object({
  name: z.string(),
  concurrency: z.number().int().positive(),
  pollIntervalMs: z.number().int().positive(),
  jobTimeoutMs: z.number().int().positive(),
  enabled: z.boolean(),
});

/**
 * Worker configuration schema
 */
const workerConfigSchema = z.object({
  /** Unique worker identifier */
  workerId: z.string().min(1),

  /** Queue configurations */
  queues: z.object({
    default: queueConfigSchema,
    large_files: queueConfigSchema,
    priority: queueConfigSchema,
    ai: queueConfigSchema,
  }),

  /** Processing settings */
  processing: z.object({
    thumbnail: z.object({
      size: z.number().int().positive(),
      quality: z.number().int().min(1).max(100),
    }),
    preview: z.object({
      maxSize: z.number().int().positive(),
      quality: z.number().int().min(1).max(100),
    }),
    largeFileThresholdBytes: z.number().int().positive(),
    maxFileSizeBytes: z.number().int().positive(),
  }),

  /** Retry settings */
  retry: z.object({
    maxAttempts: z.number().int().positive(),
    baseDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
  }),

  /** Temp file settings */
  tempFiles: z.object({
    directory: z.string(),
    cleanupIntervalMs: z.number().int().positive(),
    ttlMs: z.number().int().positive(),
  }),

  /** Shutdown settings */
  shutdown: z.object({
    timeoutMs: z.number().int().positive(),
  }),

  /** Server settings */
  server: z.object({
    port: z.number().int().positive(),
    metricsPath: z.string(),
  }),
});

export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/**
 * Helper to get environment variable with optional default
 */
function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Helper to get boolean environment variable
 */
function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Helper to get numeric environment variable
 */
function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return num;
}

/**
 * Generate a unique worker ID
 */
function generateWorkerId(): string {
  const hostname = process.env.HOSTNAME || 'worker';
  const pid = process.pid;
  const random = Math.random().toString(36).substring(2, 8);
  return `${hostname}-${pid}-${random}`;
}

/**
 * Load worker configuration from environment variables
 */
function loadWorkerConfig(): WorkerConfig {
  const config = {
    workerId: getEnv('WORKER_ID', generateWorkerId()),

    queues: {
      default: {
        name: 'default' as ProcessingJobQueue,
        concurrency: getEnvNumber('WORKER_DEFAULT_CONCURRENCY', 4),
        pollIntervalMs: getEnvNumber('WORKER_POLL_INTERVAL_MS', 5000),
        jobTimeoutMs: getEnvNumber('WORKER_JOB_TIMEOUT_MS', 300000), // 5 minutes
        enabled: getEnvBoolean('WORKER_DEFAULT_ENABLED', true),
      },
      large_files: {
        name: 'large_files' as ProcessingJobQueue,
        concurrency: getEnvNumber('WORKER_LARGE_FILES_CONCURRENCY', 1),
        pollIntervalMs: getEnvNumber('WORKER_POLL_INTERVAL_MS', 5000),
        jobTimeoutMs: getEnvNumber('WORKER_LARGE_FILES_TIMEOUT_MS', 600000), // 10 minutes
        enabled: getEnvBoolean('WORKER_LARGE_FILES_ENABLED', true),
      },
      priority: {
        name: 'priority' as ProcessingJobQueue,
        concurrency: getEnvNumber('WORKER_PRIORITY_CONCURRENCY', 2),
        pollIntervalMs: getEnvNumber('WORKER_PRIORITY_POLL_INTERVAL_MS', 2000), // Faster polling
        jobTimeoutMs: getEnvNumber('WORKER_JOB_TIMEOUT_MS', 300000),
        enabled: getEnvBoolean('WORKER_PRIORITY_ENABLED', true),
      },
      ai: {
        name: 'ai' as ProcessingJobQueue,
        concurrency: getEnvNumber('WORKER_AI_CONCURRENCY', 1),
        pollIntervalMs: getEnvNumber('WORKER_AI_POLL_INTERVAL_MS', 10000), // Slower polling
        jobTimeoutMs: getEnvNumber('WORKER_AI_TIMEOUT_MS', 600000), // 10 minutes
        enabled: getEnvBoolean('WORKER_AI_ENABLED', false), // Disabled by default
      },
    },

    processing: {
      thumbnail: {
        size: getEnvNumber('THUMBNAIL_SIZE', 300),
        quality: getEnvNumber('THUMBNAIL_QUALITY', 80),
      },
      preview: {
        maxSize: getEnvNumber('PREVIEW_MAX_SIZE', 1200),
        quality: getEnvNumber('PREVIEW_QUALITY', 85),
      },
      largeFileThresholdBytes: getEnvNumber('LARGE_FILE_THRESHOLD_MB', 100) * 1024 * 1024,
      maxFileSizeBytes: getEnvNumber('MAX_FILE_SIZE_MB', 500) * 1024 * 1024,
    },

    retry: {
      maxAttempts: getEnvNumber('WORKER_MAX_ATTEMPTS', 5),
      baseDelayMs: getEnvNumber('WORKER_RETRY_BASE_DELAY_MS', 30000), // 30 seconds
      maxDelayMs: getEnvNumber('WORKER_RETRY_MAX_DELAY_MS', 3600000), // 1 hour
    },

    tempFiles: {
      directory: getEnv('TEMP_DIR', '/tmp/worker'),
      cleanupIntervalMs: getEnvNumber('TEMP_FILE_CLEANUP_INTERVAL_MS', 300000), // 5 minutes
      ttlMs: getEnvNumber('TEMP_FILE_TTL_MS', 3600000), // 1 hour
    },

    shutdown: {
      timeoutMs: getEnvNumber('WORKER_SHUTDOWN_TIMEOUT_MS', 30000), // 30 seconds
    },

    server: {
      port: getEnvNumber('WORKER_PORT', 3001),
      metricsPath: getEnv('WORKER_METRICS_PATH', '/metrics'),
    },
  };

  // Validate configuration
  return workerConfigSchema.parse(config);
}

/**
 * Worker configuration (loaded once at startup)
 */
export const workerConfig = loadWorkerConfig();
