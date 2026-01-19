import { z } from 'zod';

/**
 * Storage configuration schema
 */
const storageConfigSchema = z.object({
  /** S3-compatible endpoint URL */
  endpoint: z.string().url(),
  /** Access key ID */
  accessKey: z.string().min(1),
  /** Secret access key */
  secretKey: z.string().min(1),
  /** Default bucket name */
  bucket: z.string().min(1),
  /** AWS region (default: us-east-1) */
  region: z.string().default('us-east-1'),
  /** Force path-style URLs (required for MinIO) */
  forcePathStyle: z.boolean().default(true),
  /** Presigned URL expiration in seconds */
  presignedUrlExpiration: z.number().int().positive().default(3600),
  /** Maximum upload size in bytes (default: 100MB) */
  maxUploadSize: z.number().int().positive().default(100 * 1024 * 1024),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

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
 * Load storage configuration from environment variables
 */
function loadStorageConfig(): StorageConfig {
  const config = {
    endpoint: getEnv('S3_ENDPOINT', 'http://localhost:9000'),
    accessKey: getEnv('S3_ACCESS_KEY', 'memoriahub'),
    secretKey: getEnv('S3_SECRET_KEY', 'memoriahub_dev_secret'),
    bucket: getEnv('S3_BUCKET', 'memoriahub'),
    region: getEnv('S3_REGION', 'us-east-1'),
    forcePathStyle: getEnvBoolean('S3_FORCE_PATH_STYLE', true),
    presignedUrlExpiration: getEnvNumber('S3_PRESIGNED_URL_EXPIRATION', 3600),
    maxUploadSize: getEnvNumber('S3_MAX_UPLOAD_SIZE', 100 * 1024 * 1024),
  };

  // Validate configuration
  return storageConfigSchema.parse(config);
}

/**
 * Storage configuration (loaded once at startup)
 */
export const storageConfig = loadStorageConfig();
