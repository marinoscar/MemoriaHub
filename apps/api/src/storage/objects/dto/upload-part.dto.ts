/**
 * What `ObjectsService.uploadPart` reports for one stored part (issue #506).
 *
 * The HTTP route itself answers like an S3 presigned part PUT — an empty body
 * and the quoted MD5 in the `ETag` header (docs/specs/android-media-sync.md
 * §6.1) — so one client code path handles both kinds of part URL.
 */
export interface UploadPartResponseDto {
  partNumber: number;
  /** Quoted MD5 hex of the part, e.g. `"9e107d9d372bb6826bd81d3542a419d6"`. */
  eTag: string;
  /** Bytes received for this part. */
  size: number;
}

/**
 * Machine-readable reasons carried in `details.reason` by the part-upload and
 * complete routes, so a client branches on a stable string, not a message.
 */
export const UPLOAD_ERROR_REASONS = {
  /** 400: the object is not `pending`/`uploading` (not an active multipart upload). */
  UPLOAD_NOT_ACTIVE: 'UPLOAD_NOT_ACTIVE',
  /** 400: this upload's provider takes parts at presigned URLs, not via the API. */
  PRESIGNED_PARTS_REQUIRED: 'PRESIGNED_PARTS_REQUIRED',
  /** 400: `partNumber` is outside `1..totalParts`. */
  PART_OUT_OF_RANGE: 'PART_OUT_OF_RANGE',
  /** 400: the body is not `partSize` bytes (or the remainder, for the last part). */
  PART_SIZE_MISMATCH: 'PART_SIZE_MISMATCH',
  /** 415: the body was not sent as raw bytes (e.g. JSON or text). */
  RAW_BODY_REQUIRED: 'RAW_BODY_REQUIRED',
  /** 409: `complete` found missing or corrupt parts; see `details.partNumbers`. */
  UPLOAD_PARTS_MISSING: 'UPLOAD_PARTS_MISSING',
  /**
   * 409: the provider no longer knows this multipart session (or the ETags
   * are not its own). The client aborts and re-initializes the upload.
   */
  UPLOAD_SESSION_INVALID: 'UPLOAD_SESSION_INVALID',
} as const;
