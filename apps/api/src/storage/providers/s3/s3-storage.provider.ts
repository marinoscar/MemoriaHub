import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { StorageProvider } from '../storage-provider.interface';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
} from '../storage-provider.types';

/**
 * Explicit configuration for building an S3StorageProvider instance outside
 * of the NestJS DI container (e.g. from a credential row in the database).
 * All fields are optional so callers only need to supply what they have.
 */
export interface S3ProviderConfig {
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  maxAttempts?: number;
  retryMode?: 'standard' | 'adaptive' | 'legacy';
  forcePathStyle?: boolean;
  /** Part size in bytes for the SDK Upload helper (default: 10 485 760 = 10 MB) */
  partSize?: number;
}

/**
 * S3-compatible storage provider implementation
 * Supports AWS S3, MinIO, LocalStack, and other S3-compatible storage services.
 *
 * When constructed with an explicit `S3ProviderConfig` (via the optional second
 * constructor parameter) the provider is built entirely from that config, which
 * allows `StorageProviderResolver` to instantiate per-credential providers at
 * runtime without going through the NestJS DI container.
 *
 * When the explicit config is absent, the provider falls back to the existing
 * ConfigService-based behaviour so existing DI registrations, BackupService
 * injection, and all existing tests continue to work unchanged.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly explicitPartSize: number | undefined;

  constructor(
    private readonly configService: ConfigService,
    @Optional() explicitConfig?: S3ProviderConfig,
  ) {
    if (explicitConfig) {
      // ----------------------------------------------------------------
      // Explicit-config path: used by StorageProviderResolver when
      // building a provider from a database credential row.
      // ----------------------------------------------------------------
      const {
        region,
        endpoint,
        accessKeyId,
        secretAccessKey,
        bucket,
        maxAttempts = 5,
        retryMode = 'adaptive',
        forcePathStyle,
        partSize,
      } = explicitConfig;

      this.bucket = bucket || '';
      this.explicitPartSize = partSize;

      if (!this.bucket) {
        this.logger.warn('S3 bucket not configured (explicit config)');
      }

      this.s3Client = new S3Client({
        region,
        endpoint,
        credentials:
          accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey }
            : undefined,
        forcePathStyle: forcePathStyle ?? !!endpoint,
        maxAttempts,
        retryMode,
        // Since SDK v3.729 the default is 'WHEN_SUPPORTED', which adds CRC32
        // streaming-trailer checksums (aws-chunked) to server-side PutObject /
        // Upload requests.  Cloudflare R2 (and other S3-compatible stores)
        // reject these with a 400.  'WHEN_REQUIRED' restores pre-3.729 behaviour:
        // checksums are only sent when the specific operation mandates one, which
        // is compatible with both R2 and real AWS S3.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });

      this.logger.log(
        `S3StorageProvider initialized (explicit config) - Bucket: ${this.bucket}, Region: ${region}${endpoint ? `, Endpoint: ${endpoint}` : ''}`,
      );
    } else {
      // ----------------------------------------------------------------
      // ConfigService path: original behaviour, unchanged.
      // ----------------------------------------------------------------
      const region = this.configService.get<string>('storage.s3.region');
      const endpoint = this.configService.get<string>('storage.s3.endpoint');
      const accessKeyId = this.configService.get<string>('storage.s3.accessKeyId');
      const secretAccessKey = this.configService.get<string>('storage.s3.secretAccessKey');

      this.bucket = this.configService.get<string>('storage.s3.bucket') || '';

      if (!this.bucket) {
        this.logger.warn('S3 bucket not configured');
      }

      this.s3Client = new S3Client({
        region,
        endpoint,
        credentials:
          accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey }
            : undefined,
        // Force path-style URLs for MinIO/LocalStack compatibility
        forcePathStyle: !!endpoint,
        maxAttempts: this.configService.get<number>('storage.s3.maxAttempts', 5),
        retryMode: this.configService.get<string>('storage.s3.retryMode', 'adaptive') as 'standard' | 'adaptive' | 'legacy',
        // Since SDK v3.729 the default is 'WHEN_SUPPORTED', which adds CRC32
        // streaming-trailer checksums (aws-chunked) to server-side PutObject /
        // Upload requests.  Cloudflare R2 (and other S3-compatible stores)
        // reject these with a 400.  'WHEN_REQUIRED' restores pre-3.729 behaviour:
        // checksums are only sent when the specific operation mandates one, which
        // is compatible with both R2 and real AWS S3.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });

      this.logger.log(
        `S3StorageProvider initialized - Bucket: ${this.bucket}, Region: ${region}${endpoint ? `, Endpoint: ${endpoint}` : ''}`,
      );
    }
  }

  /**
   * Simple upload using AWS SDK Upload helper
   * Automatically handles multipart uploads for large files
   */
  async upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    this.logger.debug(`Starting upload for key: ${key}`);

    try {
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentType: options.mimeType,
          Metadata: options.metadata || {},
          ContentLength: options.contentLength,
        },
        // Use explicit part size when provided, otherwise fall back to config
        partSize: this.explicitPartSize ?? this.configService.get<number>('storage.partSize', 10485760), // 10MB default
      });

      const result = await upload.done();

      this.logger.log(`Upload completed for key: ${key}`);

      return {
        key,
        bucket: this.bucket,
        location: result.Location || `${this.bucket}/${key}`,
        eTag: result.ETag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Upload failed for key ${key}: ${message}`, stack);
      throw error;
    }
  }

  /**
   * Initialize multipart upload
   */
  async initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit> {
    this.logger.debug(`Initiating multipart upload for key: ${key}`);

    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.mimeType,
        Metadata: options.metadata || {},
      });

      const result = await this.s3Client.send(command);

      if (!result.UploadId) {
        throw new Error('Failed to initiate multipart upload - no UploadId returned');
      }

      this.logger.log(`Multipart upload initiated for key: ${key}, UploadId: ${result.UploadId}`);

      return {
        uploadId: result.UploadId,
        key,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to initiate multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate signed URL for uploading a specific part
   */
  async getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = 3600,
  ): Promise<string> {
    this.logger.debug(
      `Generating signed upload URL for key: ${key}, part: ${partNumber}`,
    );

    try {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed upload URL for key ${key}, part ${partNumber}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Complete multipart upload
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult> {
    this.logger.debug(
      `Completing multipart upload for key: ${key}, ${parts.length} parts`,
    );

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      });

      const result = await this.s3Client.send(command);

      this.logger.log(`Multipart upload completed for key: ${key}`);

      return {
        key,
        bucket: this.bucket,
        location: result.Location || `${this.bucket}/${key}`,
        eTag: result.ETag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to complete multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Abort multipart upload
   */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.logger.debug(`Aborting multipart upload for key: ${key}`);

    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      });

      await this.s3Client.send(command);

      this.logger.log(`Multipart upload aborted for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to abort multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Download file as stream
   */
  async download(key: string): Promise<Readable> {
    this.logger.debug(`Downloading file for key: ${key}`);

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const result = await this.s3Client.send(command);

      if (!result.Body) {
        throw new Error('No body returned from S3');
      }

      // S3 returns a readable stream
      return result.Body as Readable;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to download file for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate signed download URL
   */
  async getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    this.logger.debug(`Generating signed download URL for key: ${key}`);

    try {
      const expiresIn = options?.expiresIn || 3600;

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options?.responseContentDisposition,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed download URL for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Delete file
   */
  async delete(key: string): Promise<void> {
    this.logger.debug(`Deleting file for key: ${key}`);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);

      this.logger.log(`File deleted for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to delete file for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getMetadata(key: string): Promise<Record<string, string> | null> {
    this.logger.debug(`Getting metadata for key: ${key}`);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const result = await this.s3Client.send(command);

      return result.Metadata || {};
    } catch (error) {
      if (error instanceof NotFound || (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to get metadata for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Set file metadata
   * Uses CopyObject with REPLACE metadata directive
   */
  async setMetadata(
    key: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    this.logger.debug(`Setting metadata for key: ${key}`);

    try {
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        Key: key,
        CopySource: `${this.bucket}/${key}`,
        Metadata: metadata,
        MetadataDirective: 'REPLACE',
      });

      await this.s3Client.send(command);

      this.logger.log(`Metadata updated for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to set metadata for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if (error instanceof NotFound || (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Error checking existence for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Get bucket name
   */
  getBucket(): string {
    return this.bucket;
  }

  /**
   * Generate a signed URL for a direct (single-part) PUT upload.
   */
  async getSignedPutUrl(
    key: string,
    options?: { contentType?: string; expiresIn?: number },
  ): Promise<string> {
    this.logger.debug(`Generating signed PUT URL for key: ${key}`);

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
      });

      return await getSignedUrl(this.s3Client, command, {
        expiresIn: options?.expiresIn ?? 3600,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to generate signed PUT URL for key ${key}: ${message}`, stack);
      throw error;
    }
  }

  /**
   * Get the byte size of an object, or null if it does not exist.
   */
  async getObjectSize(key: string): Promise<number | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const result = await this.s3Client.send(command);
      return typeof result.ContentLength === 'number' ? result.ContentLength : null;
    } catch (error) {
      if (
        error instanceof NotFound ||
        (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')
      ) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to get object size for key ${key}: ${message}`, stack);
      throw error;
    }
  }
}
