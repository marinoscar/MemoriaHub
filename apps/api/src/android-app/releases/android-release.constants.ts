// =============================================================================
// Android APK releases (issue #504, epic #498) — constants
// =============================================================================
//
// The deployment hosts the Android app's APKs itself: an administrator (or
// `memoriahub android publish`) uploads a signed APK, users download it
// through a short-lived signed link, and paired phones learn whether an update
// is available. The bytes live in object storage under `android-releases/`
// (NOT `storage_objects` rows); the `android_app_releases` row holds the key
// and the provider/bucket they were written to.
//
// A NO-IMPORT LEAF, so the controllers, the service, the Doctor checks (#507)
// and the tests can all import it without inviting a cycle.
// =============================================================================

/** The object-storage key prefix every APK is written under. */
export const ANDROID_RELEASES_KEY_PREFIX = 'android-releases/';

/** The largest APK accepted, in bytes (150 MiB). */
export const MAX_APK_BYTES = 150 * 1024 * 1024;

/** Android's own ceiling on `versionCode` is 2_100_000_000. */
export const MIN_VERSION_CODE = 1;
export const MAX_VERSION_CODE = 2_100_000_000;

export const MAX_VERSION_NAME_LENGTH = 50;
export const MAX_RELEASE_NOTES_LENGTH = 2000;

/** Every APK is a ZIP: local file header signature `PK\x03\x04`. */
export const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const APK_MIME_TYPE = 'application/vnd.android.package-archive';

/** The multipart field carrying the APK. */
export const APK_FILE_FIELD = 'apk';

/** Multipart parser limits for the upload route (spec §6.5). */
export const APK_UPLOAD_LIMITS = {
  fileSize: MAX_APK_BYTES,
  files: 1,
  fields: 16,
  fieldSize: 16 * 1024,
} as const;

/** How long a download link works, in seconds. */
export const DOWNLOAD_LINK_TTL_SECONDS = 10 * 60;

/** `deriveSubKey` purpose of the download-link HMAC key (spec §22 D2). */
export const DOWNLOAD_TOKEN_KEY_PURPOSE = 'android-app-download';

/** Path (under `/api`) a download link points at. */
export const DOWNLOAD_ROUTE_PREFIX = '/api/android-app/download/';

/** The raw-SQL partial unique index: at most one current release. */
export const ONE_CURRENT_RELEASE_INDEX = 'android_app_releases_one_current_uniq_idx';

/** The file-name stem of a downloaded APK (spec §2: `memoriahub-android-<versionName>.apk`). */
export const ANDROID_APK_STEM = 'memoriahub-android';

/** The release build's applicationId. Documentation only: an upload names its own package. */
export const DEFAULT_ANDROID_PACKAGE_NAME = 'memoriahub.marin.cr';

/** Refusal reasons, published under `details.reason` (spec §17.2). */
export const ANDROID_RELEASE_REASONS = {
  VERSION_EXISTS: 'RELEASE_VERSION_EXISTS',
  VERSION_NOT_NEWER: 'RELEASE_VERSION_NOT_NEWER',
  IS_CURRENT: 'RELEASE_IS_CURRENT',
  CURRENT_CONFLICT: 'RELEASE_CURRENT_CONFLICT',
  NOT_FOUND: 'RELEASE_NOT_FOUND',
  NO_RELEASE: 'NO_RELEASE',
  NOT_AN_APK: 'RELEASE_NOT_AN_APK',
  TOO_LARGE: 'RELEASE_TOO_LARGE',
  INVALID_UPLOAD: 'RELEASE_INVALID_UPLOAD',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
  LINK_INVALID: 'DOWNLOAD_LINK_INVALID',
  LINK_EXPIRED: 'DOWNLOAD_LINK_EXPIRED',
} as const;

/** Audit actions. */
export const ANDROID_RELEASE_AUDIT = {
  UPLOADED: 'android_app.release.uploaded',
  MADE_CURRENT: 'android_app.release.made_current',
  DELETED: 'android_app.release.deleted',
} as const;

/** The storage key of a release's APK. Server-chosen only (the release id). */
export function androidReleaseKey(releaseId: string): string {
  return `${ANDROID_RELEASES_KEY_PREFIX}${releaseId}.apk`;
}

/**
 * The download's file name, `memoriahub-android-<versionName>.apk`.
 * `versionName` is validated to `[0-9A-Za-z._+-]`, so it is safe inside a
 * quoted `Content-Disposition` filename.
 */
export function apkFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.apk`;
}
