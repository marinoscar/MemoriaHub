import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { storageConfig } from './config.js';
import { logger, LogEventTypes } from '../logging/index.js';

/**
 * Storage object metadata
 */
export interface StorageObject {
  key: string;
  bucket: string;
  size: number;
  contentType: string;
  lastModified: Date;
  metadata?: Record<string, string>;
  etag?: string;
}

/**
 * Options for putting objects
 */
export interface PutObjectOptions {
  contentType: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
}

/**
 * S3-compatible storage provider for worker service
 * Focused on read/write operations needed for processing
 */
export class S3StorageProvider {
  readonly providerName = 's3';
  private client: S3Client;

  constructor() {
    const isAwsS3 = storageConfig.endpoint.includes('s3.amazonaws.com') ||
                    (storageConfig.endpoint.includes('s3.') && storageConfig.endpoint.includes('.amazonaws.com'));

    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: storageConfig.region,
      credentials: {
        accessKeyId: storageConfig.accessKey,
        secretAccessKey: storageConfig.secretKey,
      },
      forcePathStyle: storageConfig.forcePathStyle,
    };

    if (!isAwsS3) {
      clientConfig.endpoint = storageConfig.endpoint;
    }

    this.client = new S3Client(clientConfig);

    logger.info({
      eventType: 's3.provider.initialized',
      endpoint: storageConfig.endpoint,
      bucket: storageConfig.bucket,
      region: storageConfig.region,
    }, 'S3 storage provider initialized');
  }

  /**
   * Upload an object to S3
   */
  async putObject(
    bucket: string,
    key: string,
    body: Buffer | Readable,
    options: PutObjectOptions
  ): Promise<void> {
    const startTime = Date.now();

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          Metadata: options.metadata,
          CacheControl: options.cacheControl,
        })
      );

      logger.debug({
        eventType: LogEventTypes.S3_UPLOAD_COMPLETED,
        bucket,
        key,
        contentType: options.contentType,
        durationMs: Date.now() - startTime,
      }, 'Object uploaded to S3');
    } catch (error) {
      logger.error({
        eventType: LogEventTypes.S3_UPLOAD_ERROR,
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      }, 'Failed to upload object to S3');
      throw error;
    }
  }

  /**
   * Download an object from S3
   */
  async getObject(
    bucket: string,
    key: string
  ): Promise<{ body: Readable; metadata: StorageObject }> {
    const startTime = Date.now();

    try {
      logger.debug({
        eventType: LogEventTypes.S3_DOWNLOAD_STARTED,
        bucket,
        key,
      }, 'Starting S3 download');

      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      logger.debug({
        eventType: LogEventTypes.S3_DOWNLOAD_COMPLETED,
        bucket,
        key,
        size: response.ContentLength,
        durationMs: Date.now() - startTime,
      }, 'Object retrieved from S3');

      return {
        body: response.Body as Readable,
        metadata: {
          key,
          bucket,
          size: response.ContentLength || 0,
          contentType: response.ContentType || 'application/octet-stream',
          lastModified: response.LastModified || new Date(),
          metadata: response.Metadata,
          etag: response.ETag,
        },
      };
    } catch (error) {
      logger.error({
        eventType: LogEventTypes.S3_DOWNLOAD_ERROR,
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      }, 'Failed to get object from S3');
      throw error;
    }
  }

  /**
   * Get object metadata without downloading
   */
  async headObject(bucket: string, key: string): Promise<StorageObject> {
    const startTime = Date.now();

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      logger.debug({
        eventType: 's3.headObject',
        bucket,
        key,
        size: response.ContentLength,
        durationMs: Date.now() - startTime,
      }, 'Object metadata retrieved');

      return {
        key,
        bucket,
        size: response.ContentLength || 0,
        contentType: response.ContentType || 'application/octet-stream',
        lastModified: response.LastModified || new Date(),
        metadata: response.Metadata,
        etag: response.ETag,
      };
    } catch (error) {
      logger.error({
        eventType: 's3.headObject.error',
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Failed to get object metadata');
      throw error;
    }
  }

  /**
   * Check if an object exists
   */
  async objectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.headObject(bucket, key);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'NotFound' ||
         error.name === 'NoSuchKey' ||
         (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Health check - verify bucket access
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: storageConfig.bucket,
          MaxKeys: 1,
        })
      );
      return true;
    } catch (error) {
      logger.warn({
        eventType: LogEventTypes.HEALTH_CHECK_FAILED,
        check: 's3',
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'S3 health check failed');
      return false;
    }
  }

  /**
   * Get the default bucket name
   */
  get defaultBucket(): string {
    return storageConfig.bucket;
  }
}

// Export singleton instance
export const s3StorageProvider = new S3StorageProvider();
