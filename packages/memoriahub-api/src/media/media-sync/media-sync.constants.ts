// =============================================================================
// Media Sync (Android native companion, epic #498, issue #505): vocabulary,
// bounds, retention and refusal reasons.
// =============================================================================
//
// The vocabulary and the limits live in `@marinoscar/memoriahub-contract/media-sync`
// and the refusal reasons in `@marinoscar/memoriahub-contract/errors`, so the
// DTO schemas, the service, the web app, the CLI and the tests share one
// definition of every value; re-exported here so the module keeps its import
// path. Only the audit names are the API's own.
// =============================================================================

export * from '@marinoscar/memoriahub-contract/media-sync';
import { MEDIA_SYNC_ERROR_REASONS, type MediaSyncErrorReason } from '@marinoscar/memoriahub-contract/errors';

/**
 * Refusals, carried at `details.reason`. The error `code` is derived from the
 * HTTP status by `HttpExceptionFilter`; clients key off `details.reason`.
 *
 * @stability experimental
 */
export const MEDIA_SYNC_REASONS = MEDIA_SYNC_ERROR_REASONS;

/**
 * One Media Sync refusal reason (`details.reason`).
 *
 * @stability experimental
 */
export type MediaSyncReason = MediaSyncErrorReason;

/**
 * Audit action written for every desired-config change.
 *
 * @stability experimental
 */
export const AUDIT_CONFIG_UPDATED = 'media_sync.config.updated';

/**
 * Audit action written for every command (`pause`, `resume`, `retry_failed`, `sync_now`).
 *
 * @stability experimental
 */
export const AUDIT_COMMAND = 'media_sync.command';

/**
 * Audit target type of a Media Sync device.
 *
 * @stability experimental
 */
export const AUDIT_TARGET_TYPE = 'media_sync_device';
