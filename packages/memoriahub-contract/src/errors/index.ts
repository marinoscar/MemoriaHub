/**
 * @packageDocumentation
 * Machine-readable refusal reasons of the MemoriaHub domain. The error `code`
 * of a response is derived from the HTTP status; a client keys off
 * `details.reason`. Platform reasons (storage upload, identity) belong to
 * `@marinoscar/platform-contract` and are not redefined here, but the three
 * reasons a MemoriaHub client (the CLI uploader, the Android download page)
 * keys off are listed below so those clients import a constant from this leaf
 * package instead of repeating a literal.
 */

import { z } from 'zod';

/**
 * Refusals of the Media Sync routes, carried at `details.reason`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_ERROR_REASONS = Object.freeze({
  PAT_REQUIRED: 'PAT_REQUIRED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  UNKNOWN_FOLDER: 'UNKNOWN_FOLDER',
  INVENTORY_NOT_ALLOWED: 'INVENTORY_NOT_ALLOWED',
  TARGET_CIRCLE_FORBIDDEN: 'TARGET_CIRCLE_FORBIDDEN',
  /** The refusal of a `targetOwner` (the `targetCircleId` refusal is unchanged). */
  TARGET_OWNER_FORBIDDEN: 'TARGET_OWNER_FORBIDDEN',
  NO_TARGET_CIRCLE: 'NO_TARGET_CIRCLE',
  UNKNOWN_SOURCE_DEVICE: 'UNKNOWN_SOURCE_DEVICE',
} as const);

/**
 * One Media Sync refusal reason.
 *
 * @stability stable
 */
export type MediaSyncErrorReason = (typeof MEDIA_SYNC_ERROR_REASONS)[keyof typeof MEDIA_SYNC_ERROR_REASONS];

/**
 * Refusals of the retired pre-packages public-share route.
 *
 * @stability stable
 */
export const SHARE_ERROR_REASONS = Object.freeze({
  LEGACY_SHARE_ROUTE: 'LEGACY_SHARE_ROUTE',
} as const);

/**
 * One public-share refusal reason.
 *
 * @stability stable
 */
export type ShareErrorReason = (typeof SHARE_ERROR_REASONS)[keyof typeof SHARE_ERROR_REASONS];

/**
 * The storage-upload refusals a client recovers from: the same strings the
 * platform storage API answers (409, at `details.reason`). Listed here so the
 * CLI uploader keys off a constant of this package.
 *
 *  - `UPLOAD_PARTS_MISSING`: `complete` found parts the backend does not hold;
 *    `details.partNumbers` lists them, re-send those and complete again.
 *  - `UPLOAD_SESSION_INVALID`: the backend lost the multipart session; abort and
 *    initialise a new upload.
 *
 * @stability stable
 */
export const UPLOAD_ERROR_REASONS = Object.freeze({
  UPLOAD_PARTS_MISSING: 'UPLOAD_PARTS_MISSING',
  UPLOAD_SESSION_INVALID: 'UPLOAD_SESSION_INVALID',
} as const);

/**
 * One storage-upload refusal reason.
 *
 * @stability stable
 */
export type UploadErrorReason = (typeof UPLOAD_ERROR_REASONS)[keyof typeof UPLOAD_ERROR_REASONS];

/**
 * The `details` of a 409 `UPLOAD_PARTS_MISSING`: the part numbers to send again.
 *
 * @stability stable
 */
export const uploadPartsMissingDetailsSchema = z.object({
  reason: z.literal(UPLOAD_ERROR_REASONS.UPLOAD_PARTS_MISSING),
  partNumbers: z.array(z.number().int().positive()),
});

/**
 * The inferred type of {@link uploadPartsMissingDetailsSchema}.
 *
 * @stability stable
 */
export type UploadPartsMissingDetails = z.infer<typeof uploadPartsMissingDetailsSchema>;

/**
 * Refusals of the Android app routes a MemoriaHub client reads, carried at
 * `details.reason`. `NO_RELEASE` is the 404 of `GET /api/android-app/releases/latest`
 * when no release is current: an empty state, not a failure.
 *
 * @stability stable
 */
export const ANDROID_APP_ERROR_REASONS = Object.freeze({
  NO_RELEASE: 'NO_RELEASE',
} as const);

/**
 * One Android app refusal reason.
 *
 * @stability stable
 */
export type AndroidAppErrorReason = (typeof ANDROID_APP_ERROR_REASONS)[keyof typeof ANDROID_APP_ERROR_REASONS];

/**
 * The `details` of an error body that carries a machine-readable reason.
 *
 * @stability stable
 */
export const errorReasonDetailsSchema = z.object({ reason: z.string() }).passthrough();
