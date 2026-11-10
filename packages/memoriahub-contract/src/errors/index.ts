/**
 * @packageDocumentation
 * Machine-readable refusal reasons of the MemoriaHub domain. The error `code`
 * of a response is derived from the HTTP status; a client keys off
 * `details.reason`. Platform reasons (storage upload, identity) belong to
 * `@marinoscar/platform-contract` and are not redefined here.
 */

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
