import { Readable } from 'stream';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
} from './storage-provider.types';

/**
 * Dependency injection token for storage provider
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

/**
 * Abstract interface for file storage providers
 * Supports both simple uploads and multipart resumable uploads
 */
export interface StorageProvider {
  /**
   * Simple upload for small to medium files
   * Stream is uploaded directly to storage
   *
   * @param key - Unique identifier for the file in storage
   * @param stream - Readable stream of file content
   * @param options - Upload configuration (MIME type, metadata, etc.)
   * @returns Upload result with location and metadata
   */
  upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult>;

  /**
   * Initialize a multipart upload for large files or resumable uploads
   *
   * @param key - Unique identifier for the file in storage
   * @param options - Upload configuration (MIME type, metadata, etc.)
   * @returns Upload ID and key for subsequent operations
   */
  initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit>;

  /**
   * Generate a signed URL for uploading a specific part
   * Client can use this URL to upload parts directly to storage
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   * @param partNumber - Part number (1-based index)
   * @param expiresIn - URL expiration time in seconds (default: 3600)
   * @returns Pre-signed URL for part upload
   */
  getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;

  /**
   * Complete a multipart upload after all parts are uploaded
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   * @param parts - Array of uploaded parts with part numbers and ETags
   * @returns Upload result with final location
   */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult>;

  /**
   * Abort a multipart upload and clean up parts
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /**
   * Download a file as a readable stream
   *
   * @param key - Unique identifier for the file in storage
   * @returns Readable stream of file content
   */
  download(key: string): Promise<Readable>;

  /**
   * Generate a signed URL for downloading a file
   * Allows temporary access without authentication
   *
   * @param key - Unique identifier for the file in storage
   * @param options - URL generation options (expiration, content disposition)
   * @returns Pre-signed URL for file download
   */
  getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string>;

  /**
   * Delete a file from storage
   *
   * @param key - Unique identifier for the file in storage
   */
  delete(key: string): Promise<void>;

  /**
   * Batched, best-effort delete of many files in as few round-trips as
   * possible (e.g. S3's native `DeleteObjects`, up to 1000 keys per call).
   *
   * This method NEVER throws for individual key failures — any per-key or
   * per-chunk error is collected into the returned `errors` array so a caller
   * purging thousands of objects can continue past isolated failures. An empty
   * `keys` input returns `{ deleted: 0, errors: [] }` without any round-trip.
   *
   * @param keys - Storage keys to delete
   * @returns The count of successfully-deleted keys plus a list of the keys
   *   that failed, each with its failure message
   */
  deleteMany(
    keys: string[],
  ): Promise<{ deleted: number; errors: { key: string; message: string }[] }>;

  /**
   * Get file metadata
   *
   * @param key - Unique identifier for the file in storage
   * @returns Metadata key-value pairs, or null if file doesn't exist
   */
  getMetadata(key: string): Promise<Record<string, string> | null>;

  /**
   * Set or update file metadata
   *
   * @param key - Unique identifier for the file in storage
   * @param metadata - Metadata key-value pairs to set
   */
  setMetadata(key: string, metadata: Record<string, string>): Promise<void>;

  /**
   * Check if a file exists in storage
   *
   * @param key - Unique identifier for the file in storage
   * @returns True if file exists, false otherwise
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get the bucket name being used by this provider
   *
   * @returns Bucket name
   */
  getBucket(): string;

  /**
   * Generate a signed URL for a DIRECT (single-part) PUT upload to `key` —
   * distinct from {@link getSignedUploadUrl}, which signs one PART of an
   * already-initiated multipart upload and requires a matching
   * completeMultipartUpload call. This is for callers that only need a plain
   * "PUT these bytes here" URL with no multipart bookkeeping — currently the
   * node data-plane's thumbnail-upload flow
   * (`POST /api/nodes/:id/jobs/:jobId/upload-url`).
   *
   * @param key - Unique identifier for the file in storage
   * @param options - Optional content type and URL expiration (seconds)
   * @returns Pre-signed URL for a direct PUT
   */
  getSignedPutUrl(
    key: string,
    options?: { contentType?: string; expiresIn?: number },
  ): Promise<string>;

  /**
   * Get the byte size of an object, or null if it does not exist.
   *
   * Used to validate a client-reported byte count (e.g. a node's thumbnail
   * upload) against what was actually written to storage.
   *
   * @param key - Unique identifier for the file in storage
   */
  getObjectSize(key: string): Promise<number | null>;
}
