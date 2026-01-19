import type { Readable } from 'stream';

/**
 * Metadata about a stored object
 */
export interface StorageObject {
  /** Object key/path */
  key: string;
  /** Bucket name */
  bucket: string;
  /** Object size in bytes */
  size: number;
  /** MIME content type */
  contentType: string;
  /** Last modification time */
  lastModified: Date;
  /** User-defined metadata */
  metadata?: Record<string, string>;
  /** ETag for versioning */
  etag?: string;
}

/**
 * Options for uploading an object
 */
export interface PutObjectOptions {
  /** MIME content type */
  contentType: string;
  /** User-defined metadata (stored with object) */
  metadata?: Record<string, string>;
  /** Cache-Control header */
  cacheControl?: string;
  /** Content-Disposition header */
  contentDisposition?: string;
  /** Storage class (e.g., 'STANDARD', 'REDUCED_REDUNDANCY') */
  storageClass?: string;
}

/**
 * Options for generating presigned URLs
 */
export interface PresignedUrlOptions {
  /** URL expiration time in seconds (default: 3600) */
  expiresIn?: number;
  /** Content-Type for upload URLs */
  contentType?: string;
  /** Content-Disposition for download URLs */
  contentDisposition?: string;
}

/**
 * Options for listing objects
 */
export interface ListObjectsOptions {
  /** Prefix to filter objects */
  prefix?: string;
  /** Delimiter for virtual directory structure */
  delimiter?: string;
  /** Maximum number of objects to return */
  maxKeys?: number;
  /** Continuation token for pagination */
  continuationToken?: string;
}

/**
 * Result from listing objects
 */
export interface ListObjectsResult {
  /** List of objects */
  objects: StorageObject[];
  /** Common prefixes (when using delimiter) */
  prefixes: string[];
  /** Whether more results exist */
  isTruncated: boolean;
  /** Token for next page */
  nextContinuationToken?: string;
}

/**
 * Storage provider interface (Open/Closed Principle)
 * Implement this interface to add new storage providers without modifying existing code
 *
 * Current implementations:
 * - S3StorageProvider (AWS S3 / MinIO compatible)
 *
 * Future implementations could include:
 * - Azure Blob Storage
 * - Google Cloud Storage
 * - Local filesystem
 */
export interface IStorageProvider {
  /** Unique provider identifier (e.g., 's3', 'azure', 'gcs') */
  readonly providerName: string;

  /**
   * Upload an object to storage
   * @param bucket Bucket name
   * @param key Object key/path
   * @param body Content to upload
   * @param options Upload options
   */
  putObject(
    bucket: string,
    key: string,
    body: Buffer | Readable,
    options: PutObjectOptions
  ): Promise<void>;

  /**
   * Download an object from storage
   * @param bucket Bucket name
   * @param key Object key/path
   * @returns Object body and metadata
   */
  getObject(
    bucket: string,
    key: string
  ): Promise<{ body: Readable; metadata: StorageObject }>;

  /**
   * Delete an object from storage
   * @param bucket Bucket name
   * @param key Object key/path
   */
  deleteObject(bucket: string, key: string): Promise<void>;

  /**
   * Delete multiple objects from storage
   * @param bucket Bucket name
   * @param keys Array of object keys
   */
  deleteObjects(bucket: string, keys: string[]): Promise<void>;

  /**
   * Get object metadata without downloading content
   * @param bucket Bucket name
   * @param key Object key/path
   * @returns Object metadata
   */
  headObject(bucket: string, key: string): Promise<StorageObject>;

  /**
   * Check if an object exists
   * @param bucket Bucket name
   * @param key Object key/path
   * @returns True if object exists
   */
  objectExists(bucket: string, key: string): Promise<boolean>;

  /**
   * Copy an object within storage
   * @param sourceBucket Source bucket
   * @param sourceKey Source key
   * @param destBucket Destination bucket
   * @param destKey Destination key
   */
  copyObject(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string
  ): Promise<void>;

  /**
   * List objects in a bucket
   * @param bucket Bucket name
   * @param options List options
   * @returns List of objects and pagination info
   */
  listObjects(bucket: string, options?: ListObjectsOptions): Promise<ListObjectsResult>;

  /**
   * Generate a presigned URL for uploading
   * @param bucket Bucket name
   * @param key Object key/path
   * @param options Presigned URL options
   * @returns Presigned upload URL
   */
  getPresignedUploadUrl(
    bucket: string,
    key: string,
    options?: PresignedUrlOptions
  ): Promise<string>;

  /**
   * Generate a presigned URL for downloading
   * @param bucket Bucket name
   * @param key Object key/path
   * @param options Presigned URL options
   * @returns Presigned download URL
   */
  getPresignedDownloadUrl(
    bucket: string,
    key: string,
    options?: PresignedUrlOptions
  ): Promise<string>;

  /**
   * Check if the storage provider is healthy and accessible
   * @returns True if healthy
   */
  healthCheck(): Promise<boolean>;
}
