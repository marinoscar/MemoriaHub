// =============================================================================
// Media Sync (Android native companion, epic #498, issue #505): vocabulary,
// bounds, retention and refusal reasons.
// =============================================================================
//
// Pure data, no Nest or Prisma imports, so the DTO schemas, the service and
// the tests share one definition of every limit.
// =============================================================================

export const DEVICE_STRING_MAX = 100;
export const APP_VERSION_MAX = 50;
/** An Android application id: dot-separated segments, each starting with a letter. Never re-cased. */
export const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** The APK signing certificate SHA-256 as 32 colon-separated upper-case hex bytes. */
export const SIGNING_SHA256_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Desired config. */
export const CONFIG_FOLDERS_MAX = 200;
export const BUCKET_ID_MAX = 64;
export const FOLDER_NAME_MAX = 255;
export const RELATIVE_PATH_MAX = 1024;

/** Check-in. */
export const INVENTORY_MAX = 500;
export const FAILED_SAMPLE_MAX = 50;
export const PER_FOLDER_MAX = 200;
export const RUN_ERROR_CODE_MAX = 64;
export const FAILED_SAMPLE_ERROR_MAX = 500;
/** `MediaSyncDevice.lastError` is VARCHAR(1000). */
export const LAST_ERROR_MAX = 1000;

/** Diagnostics. */
export const DIAGNOSTIC_SUMMARY_MAX = 500;
/** `report`, serialized. */
export const DIAGNOSTIC_REPORT_MAX_BYTES = 256 * 1024;

/** Retention, enforced on insert in the same transaction. */
export const RUNS_KEPT_PER_DEVICE = 200;
export const REPORTS_KEPT_PER_DEVICE = 20;

export const RUNS_LIMIT_DEFAULT = 50;
export const RUNS_LIMIT_MAX = 200;
export const REPORTS_LIMIT_DEFAULT = 5;
export const REPORTS_LIMIT_MAX = 20;

/** Optimistic-concurrency retries for a config write that lost a race. */
export const CONFIG_WRITE_ATTEMPTS = 5;

/** Mirror the Prisma enums. */
export const MEDIA_SYNC_TRIGGERS = ['periodic', 'content_trigger', 'manual', 'app_open', 'initial'] as const;
export const MEDIA_SYNC_RUN_STATUSES = ['ok', 'partial', 'failed', 'skipped', 'paused'] as const;
export const MEDIA_SYNC_DEVICE_STATUSES = ['active', 'revoked'] as const;

export const MEDIA_SYNC_NETWORK_POLICIES = ['wifi', 'any'] as const;
export const MEDIA_SYNC_UPLOAD_EXISTING = ['all', 'from_pairing'] as const;
export const MEDIA_SYNC_PERMISSIONS = ['full', 'partial', 'denied'] as const;
export const MEDIA_SYNC_NETWORK_STATES = ['wifi', 'cellular', 'none'] as const;
export const MEDIA_SYNC_COMMANDS = ['pause', 'resume', 'retry_failed', 'sync_now'] as const;
export type MediaSyncCommand = (typeof MEDIA_SYNC_COMMANDS)[number];

/**
 * Refusals, carried at `details.reason`. The error `code` is derived from the
 * HTTP status by `HttpExceptionFilter`; clients key off `details.reason`.
 */
export const MEDIA_SYNC_REASONS = {
  PAT_REQUIRED: 'PAT_REQUIRED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  UNKNOWN_FOLDER: 'UNKNOWN_FOLDER',
  INVENTORY_NOT_ALLOWED: 'INVENTORY_NOT_ALLOWED',
  TARGET_CIRCLE_FORBIDDEN: 'TARGET_CIRCLE_FORBIDDEN',
  NO_TARGET_CIRCLE: 'NO_TARGET_CIRCLE',
  UNKNOWN_SOURCE_DEVICE: 'UNKNOWN_SOURCE_DEVICE',
} as const;
export type MediaSyncReason = (typeof MEDIA_SYNC_REASONS)[keyof typeof MEDIA_SYNC_REASONS];

/** Audit action written for every desired-config change. */
export const AUDIT_CONFIG_UPDATED = 'media_sync.config.updated';
export const AUDIT_COMMAND = 'media_sync.command';
export const AUDIT_TARGET_TYPE = 'media_sync_device';
