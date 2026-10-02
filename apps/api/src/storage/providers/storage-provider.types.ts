import { Readable } from 'stream';

/**
 * Options for uploading a file to storage
 */
export interface StorageUploadOptions {
  mimeType: string;
  metadata?: Record<string, string>;
  contentLength?: number;
  /**
   * Optional HTTP Cache-Control header to persist on the stored object so it is
   * returned on subsequent GETs (e.g. `public, max-age=31536000, immutable` for
   * immutable thumbnail bytes). Providers that don't serve objects over HTTP
   * with headers (e.g. local disk) may safely ignore this.
   */
  cacheControl?: string;
}

/**
 * Result of a successful upload operation
 */
export interface StorageUploadResult {
  key: string;
  bucket: string;
  location: string;
  eTag?: string;
}

/**
 * Represents a completed part of a multipart upload
 */
export interface UploadPart {
  partNumber: number;
  eTag: string;
}

/**
 * Options for generating signed URLs
 */
export interface SignedUrlOptions {
  expiresIn?: number; // Seconds, default 3600
  responseContentDisposition?: string;
}

/**
 * Result of initiating a multipart upload
 */
export interface MultipartUploadInit {
  uploadId: string;
  key: string;
}

/**
 * Result of writing one multipart part through the API (issue #506).
 *
 * Only providers whose part URLs a client cannot reach directly
 * (`supportsPresignedParts === false`) produce this.
 */
export interface WrittenPart {
  /** Part number (1-based). */
  partNumber: number;
  /** Quoted MD5 hex of the part bytes, in the shape S3 returns as `ETag`. */
  eTag: string;
  /** Number of bytes written. */
  size: number;
}

/** Options for {@link StorageProvider.writePart}. */
export interface WritePartOptions {
  /**
   * The exact byte count this part must have. A body that is shorter or
   * longer is rejected with {@link PartSizeMismatchError}, and nothing is
   * kept on disk.
   */
  expectedSize: number;
}

/**
 * A part body did not have the size the upload session requires.
 *
 * Thrown by `writePart`; the API maps it to 400 `PART_SIZE_MISMATCH`.
 */
export class PartSizeMismatchError extends Error {
  constructor(
    readonly partNumber: number,
    readonly expectedSize: number,
    readonly receivedSize: number,
    /** True when the body was cut off early because it exceeded `expectedSize`. */
    readonly exceeded: boolean,
  ) {
    super(
      exceeded
        ? `Part ${partNumber} is larger than the expected ${expectedSize} bytes`
        : `Part ${partNumber} has ${receivedSize} bytes, expected ${expectedSize}`,
    );
    this.name = 'PartSizeMismatchError';
  }
}

/**
 * The multipart session has no part directory on the provider any more (it
 * was completed, aborted or cleaned up). The client must re-initialize the
 * upload; the API maps this to 404, the same signal a dead S3 session gives.
 */
export class MultipartSessionNotFoundError extends Error {
  constructor(readonly uploadId: string) {
    super(`Multipart upload ${uploadId} does not exist`);
    this.name = 'MultipartSessionNotFoundError';
  }
}

/**
 * `completeMultipartUpload` found parts that are missing or whose bytes do not
 * match the eTag the client supplied (issue #506). No object is written.
 *
 * The API maps this to 409 `UPLOAD_PARTS_MISSING` with the part numbers in
 * `details.partNumbers`, so the client re-sends only those parts.
 */
export class MultipartPartsMissingError extends Error {
  constructor(readonly partNumbers: number[]) {
    super(
      `Multipart upload is missing or has corrupt part(s): ${partNumbers.join(', ')}`,
    );
    this.name = 'MultipartPartsMissingError';
  }
}
