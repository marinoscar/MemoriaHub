/** Where an administrator manages trusted apps and APK releases. */
export const ANDROID_SETTINGS_HINT = 'Admin → Settings → Android app (/admin/settings/android)';
export const ANDROID_SETTINGS_PATH = '/admin/settings/android';

/**
 * A paired Android Media Sync device that has not checked in for this long is
 * flagged by `android.media-sync` (#507). The phone's WorkManager check-in runs
 * at least every few hours; two days of silence means it is off, uninstalled
 * without unpairing, or blocked by the OS.
 */
export const ANDROID_DEVICE_STALE_HOURS = 48;

/** How many devices / apps a single Android check names before eliding with "…". */
export const ANDROID_LIST_LIMIT_DEVICES = 5;
export const ANDROID_LIST_LIMIT_APPS = 3;
