import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import type {
  IStorageProvider,
  StorageObject,
  PutObjectOptions,
  PresignedUrlOptions,
  ListObjectsOptions,
  ListObjectsResult,
} from '../../interfaces/storage/IStorageProvider.js';
import { storageConfig } from '../../config/storage.config.js';
import { logger } from '../logging/logger.js';
import { getTraceId } from '../logging/request-context.js';

/**
 * S3-compatible storage provider
 * Works with AWS S3, MinIO, and other S3-compatible services
 */
export class S3StorageProvider implements IStorageProvider {
  readonly providerName = 's3';
  private client: S3Client;

  constructor() {
    this.client = new S3Client({
      endpoint: storageConfig.endpoint,
      region: storageConfig.region,
      credentials: {
        accessKeyId: storageConfig.accessKey,
        secretAccessKey: storageConfig.secretKey,
      },
      forcePathStyle: storageConfig.forcePathStyle,
    });

    logger.info({
      eventType: 's3.provider.initialized',
      endpoint: storageConfig.endpoint,
      bucket: storageConfig.bucket,
      region: storageConfig.region,
    }, 'S3 storage provider initialized');
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer | Readable,
    options: PutObjectOptions
  ): Promise<void> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          Metadata: options.metadata,
          CacheControl: options.cacheControl,
          ContentDisposition: options.contentDisposition,
          StorageClass: options.storageClass as StorageClass | undefined,
        })
      );

      logger.debug({
        eventType: 's3.putObject',
        bucket,
        key,
        contentType: options.contentType,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Object uploaded to S3');
    } catch (error) {
      logger.error({
        eventType: 's3.putObject.error',
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to upload object to S3');
      throw error;
    }
  }

  async getObject(
    bucket: string,
    key: string
  ): Promise<{ body: Readable; metadata: StorageObject }> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      logger.debug({
        eventType: 's3.getObject',
        bucket,
        key,
        durationMs: Date.now() - startTime,
        traceId,
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
        eventType: 's3.getObject.error',
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to get object from S3');
      throw error;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      logger.debug({
        eventType: 's3.deleteObject',
        bucket,
        key,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Object deleted from S3');
    } catch (error) {
      logger.error({
        eventType: 's3.deleteObject.error',
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to delete object from S3');
      throw error;
    }
  }

  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      // S3 allows max 1000 objects per delete request
      const batches: string[][] = [];
      for (let i = 0; i < keys.length; i += 1000) {
        batches.push(keys.slice(i, i + 1000));
      }

      for (const batch of batches) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: batch.map((key) => ({ Key: key })),
              Quiet: true,
            },
          })
        );
      }

      logger.debug({
        eventType: 's3.deleteObjects',
        bucket,
        count: keys.length,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Objects deleted from S3');
    } catch (error) {
      logger.error({
        eventType: 's3.deleteObjects.error',
        bucket,
        count: keys.length,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to delete objects from S3');
      throw error;
    }
  }

  async headObject(bucket: string, key: string): Promise<StorageObject> {
    const startTime = Date.now();
    const traceId = getTraceId();

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
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Object metadata retrieved from S3');

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
        traceId,
      }, 'Failed to get object metadata from S3');
      throw error;
    }
  }

  async objectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.headObject(bucket, key);
      return true;
    } catch (error) {
      // Check if error is "NotFound" (object doesn't exist)
      if (
        error instanceof Error &&
        (error.name === 'NotFound' || error.name === 'NoSuchKey' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
      ) {
        return false;
      }
      throw error;
    }
  }

  async copyObject(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string
  ): Promise<void> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: destBucket,
          Key: destKey,
          CopySource: `${sourceBucket}/${sourceKey}`,
        })
      );

      logger.debug({
        eventType: 's3.copyObject',
        sourceBucket,
        sourceKey,
        destBucket,
        destKey,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Object copied in S3');
    } catch (error) {
      logger.error({
        eventType: 's3.copyObject.error',
        sourceBucket,
        sourceKey,
        destBucket,
        destKey,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to copy object in S3');
      throw error;
    }
  }

  async listObjects(
    bucket: string,
    options?: ListObjectsOptions
  ): Promise<ListObjectsResult> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: options?.prefix,
          Delimiter: options?.delimiter,
          MaxKeys: options?.maxKeys,
          ContinuationToken: options?.continuationToken,
        })
      );

      logger.debug({
        eventType: 's3.listObjects',
        bucket,
        prefix: options?.prefix,
        count: response.Contents?.length || 0,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Objects listed from S3');

      return {
        objects: (response.Contents || []).map((obj) => ({
          key: obj.Key || '',
          bucket,
          size: obj.Size || 0,
          contentType: 'application/octet-stream', // Not available in list response
          lastModified: obj.LastModified || new Date(),
          etag: obj.ETag,
        })),
        prefixes: (response.CommonPrefixes || []).map((p) => p.Prefix || ''),
        isTruncated: response.IsTruncated || false,
        nextContinuationToken: response.NextContinuationToken,
      };
    } catch (error) {
      logger.error({
        eventType: 's3.listObjects.error',
        bucket,
        prefix: options?.prefix,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to list objects from S3');
      throw error;
    }
  }

  async getPresignedUploadUrl(
    bucket: string,
    key: string,
    options?: PresignedUrlOptions
  ): Promise<string> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: options?.contentType,
      });

      const url = await getSignedUrl(this.client, command, {
        expiresIn: options?.expiresIn || storageConfig.presignedUrlExpiration,
      });

      logger.debug({
        eventType: 's3.getPresignedUploadUrl',
        bucket,
        key,
        expiresIn: options?.expiresIn || storageConfig.presignedUrlExpiration,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Presigned upload URL generated');

      return url;
    } catch (error) {
      logger.error({
        eventType: 's3.getPresignedUploadUrl.error',
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to generate presigned upload URL');
      throw error;
    }
  }

  async getPresignedDownloadUrl(
    bucket: string,
    key: string,
    options?: PresignedUrlOptions
  ): Promise<string> {
    const startTime = Date.now();
    const traceId = getTraceId();

    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: options?.contentDisposition,
      });

      const url = await getSignedUrl(this.client, command, {
        expiresIn: options?.expiresIn || storageConfig.presignedUrlExpiration,
      });

      logger.debug({
        eventType: 's3.getPresignedDownloadUrl',
        bucket,
        key,
        expiresIn: options?.expiresIn || storageConfig.presignedUrlExpiration,
        durationMs: Date.now() - startTime,
        traceId,
      }, 'Presigned download URL generated');

      return url;
    } catch (error) {
      logger.error({
        eventType: 's3.getPresignedDownloadUrl.error',
        bucket,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to generate presigned download URL');
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Try to list objects with max 1 to verify bucket access
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: storageConfig.bucket,
          MaxKeys: 1,
        })
      );
      return true;
    } catch (error) {
      logger.warn({
        eventType: 's3.healthCheck.failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'S3 health check failed');
      return false;
    }
  }
}

// Export singleton instance
export const s3StorageProvider = new S3StorageProvider();
