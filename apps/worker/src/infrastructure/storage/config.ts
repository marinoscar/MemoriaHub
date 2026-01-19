import { z } from 'zod';

/**
 * Storage configuration schema
 */
const storageConfigSchema = z.object({
  endpoint: z.string().url(),
  publicEndpoint: z.string().url().optional(),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  bucket: z.string().min(1),
  region: z.string().default('us-east-1'),
  forcePathStyle: z.boolean().default(true),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function loadStorageConfig(): StorageConfig {
  const endpoint = getEnv('S3_ENDPOINT', 'http://localhost:9000');
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  const config = {
    endpoint,
    publicEndpoint: publicEndpoint || undefined,
    accessKey: getEnv('S3_ACCESS_KEY', 'memoriahub'),
    secretKey: getEnv('S3_SECRET_KEY', 'memoriahub_dev_secret'),
    bucket: getEnv('S3_BUCKET', 'memoriahub'),
    region: getEnv('S3_REGION', 'us-east-1'),
    forcePathStyle: getEnvBoolean('S3_FORCE_PATH_STYLE', true),
  };

  return storageConfigSchema.parse(config);
}

export const storageConfig = loadStorageConfig();
