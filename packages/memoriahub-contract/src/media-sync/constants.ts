/**
 * @packageDocumentation
 * Media Sync (Android native companion): vocabulary, bounds and retention limits shared by the wire schemas, the service and the clients.
 */

/**
 * Media Sync limit or vocabulary `DEVICE_STRING_MAX`.
 *
 * @stability stable
 */
export const DEVICE_STRING_MAX = 100;
/**
 * Media Sync limit or vocabulary `APP_VERSION_MAX`.
 *
 * @stability stable
 */
export const APP_VERSION_MAX = 50;
/**
 * An Android application id: dot-separated segments, each starting with a letter. Never re-cased.
 *
 * @stability stable
 */
export const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/**
 * The APK signing certificate SHA-256 as 32 colon-separated upper-case hex bytes.
 *
 * @stability stable
 */
export const SIGNING_SHA256_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * Desired config.
 *
 * @stability stable
 */
export const CONFIG_FOLDERS_MAX = 200;
/**
 * Media Sync limit or vocabulary `BUCKET_ID_MAX`.
 *
 * @stability stable
 */
export const BUCKET_ID_MAX = 64;
/**
 * Media Sync limit or vocabulary `FOLDER_NAME_MAX`.
 *
 * @stability stable
 */
export const FOLDER_NAME_MAX = 255;
/**
 * Media Sync limit or vocabulary `RELATIVE_PATH_MAX`.
 *
 * @stability stable
 */
export const RELATIVE_PATH_MAX = 1024;

/**
 * Check-in.
 *
 * @stability stable
 */
export const INVENTORY_MAX = 500;
/**
 * Media Sync limit or vocabulary `FAILED_SAMPLE_MAX`.
 *
 * @stability stable
 */
export const FAILED_SAMPLE_MAX = 50;
/**
 * Media Sync limit or vocabulary `PER_FOLDER_MAX`.
 *
 * @stability stable
 */
export const PER_FOLDER_MAX = 200;
/**
 * Media Sync limit or vocabulary `RUN_ERROR_CODE_MAX`.
 *
 * @stability stable
 */
export const RUN_ERROR_CODE_MAX = 64;
/**
 * Media Sync limit or vocabulary `FAILED_SAMPLE_ERROR_MAX`.
 *
 * @stability stable
 */
export const FAILED_SAMPLE_ERROR_MAX = 500;
/**
 * `MediaSyncDevice.lastError` is VARCHAR(1000).
 *
 * @stability stable
 */
export const LAST_ERROR_MAX = 1000;

/**
 * Diagnostics.
 *
 * @stability stable
 */
export const DIAGNOSTIC_SUMMARY_MAX = 500;
/**
 * `report`, serialized.
 *
 * @stability stable
 */
export const DIAGNOSTIC_REPORT_MAX_BYTES = 256 * 1024;

/**
 * Retention, enforced on insert in the same transaction.
 *
 * @stability stable
 */
export const RUNS_KEPT_PER_DEVICE = 200;
/**
 * Media Sync limit or vocabulary `REPORTS_KEPT_PER_DEVICE`.
 *
 * @stability stable
 */
export const REPORTS_KEPT_PER_DEVICE = 20;

/**
 * Media Sync limit or vocabulary `RUNS_LIMIT_DEFAULT`.
 *
 * @stability stable
 */
export const RUNS_LIMIT_DEFAULT = 50;
/**
 * Media Sync limit or vocabulary `RUNS_LIMIT_MAX`.
 *
 * @stability stable
 */
export const RUNS_LIMIT_MAX = 200;
/**
 * Media Sync limit or vocabulary `REPORTS_LIMIT_DEFAULT`.
 *
 * @stability stable
 */
export const REPORTS_LIMIT_DEFAULT = 5;
/**
 * Media Sync limit or vocabulary `REPORTS_LIMIT_MAX`.
 *
 * @stability stable
 */
export const REPORTS_LIMIT_MAX = 20;

/**
 * Optimistic-concurrency retries for a config write that lost a race.
 *
 * @stability stable
 */
export const CONFIG_WRITE_ATTEMPTS = 5;

/**
 * Mirror the Prisma enums.
 *
 * @stability stable
 */
export const MEDIA_SYNC_TRIGGERS = ['periodic', 'content_trigger', 'manual', 'app_open', 'initial'] as const;
/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_RUN_STATUSES`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_RUN_STATUSES = ['ok', 'partial', 'failed', 'skipped', 'paused'] as const;
/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_DEVICE_STATUSES`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_DEVICE_STATUSES = ['active', 'revoked'] as const;

/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_NETWORK_POLICIES`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_NETWORK_POLICIES = ['wifi', 'any'] as const;
/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_UPLOAD_EXISTING`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_UPLOAD_EXISTING = ['all', 'from_pairing'] as const;
/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_PERMISSIONS`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_PERMISSIONS = ['full', 'partial', 'denied'] as const;
/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_NETWORK_STATES`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_NETWORK_STATES = ['wifi', 'cellular', 'none'] as const;
/**
 * Media Sync limit or vocabulary `MEDIA_SYNC_COMMANDS`.
 *
 * @stability stable
 */
export const MEDIA_SYNC_COMMANDS = ['pause', 'resume', 'retry_failed', 'sync_now'] as const;
/**
 * Media Sync limit or vocabulary `MediaSyncCommand`.
 *
 * @stability stable
 */
export type MediaSyncCommand = (typeof MEDIA_SYNC_COMMANDS)[number];

/**
 * One network policy of a device's desired config.
 *
 * @stability stable
 */
export type MediaSyncNetworkPolicy = (typeof MEDIA_SYNC_NETWORK_POLICIES)[number];

/**
 * Which existing files a device uploads on pairing.
 *
 * @stability stable
 */
export type MediaSyncUploadExisting = (typeof MEDIA_SYNC_UPLOAD_EXISTING)[number];

/**
 * The media permission a device reports.
 *
 * @stability stable
 */
export type MediaSyncPermission = (typeof MEDIA_SYNC_PERMISSIONS)[number];

/**
 * The network state a device reports.
 *
 * @stability stable
 */
export type MediaSyncNetworkState = (typeof MEDIA_SYNC_NETWORK_STATES)[number];

/**
 * Whether a device is paired or was unpaired.
 *
 * @stability stable
 */
export type MediaSyncDeviceStatus = (typeof MEDIA_SYNC_DEVICE_STATUSES)[number];

/**
 * The outcome of one sync pass.
 *
 * @stability stable
 */
export type MediaSyncRunStatus = (typeof MEDIA_SYNC_RUN_STATUSES)[number];

/**
 * What started one sync pass.
 *
 * @stability stable
 */
export type MediaSyncTrigger = (typeof MEDIA_SYNC_TRIGGERS)[number];
