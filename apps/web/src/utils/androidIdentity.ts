/**
 * The Android app's identity as the web app names it (issue #515, epic #498).
 *
 * `apps/android/identity.properties` is the source of truth; these values are
 * COPIES of it (the web build cannot read a Java properties file), and
 * `__tests__/utils/androidIdentity.test.ts` reads that file and fails the
 * build when they drift. See docs/specs/android-media-sync.md §2.
 *
 * The package name is case-sensitive everywhere (assetlinks.json, the
 * installer): never re-case it.
 */

/** `applicationId` of the release build. The legacy v1 app was `cr.marin.memoriahub`. */
export const ANDROID_PACKAGE_NAME = 'memoriahub.marin.cr';

/** The package of the retired v1 app; users must uninstall it by hand. */
export const LEGACY_ANDROID_PACKAGE_NAME = 'cr.marin.memoriahub';

/** Custom scheme of the app's deep links. */
export const ANDROID_DEEP_LINK_SCHEME = 'memoriahub';

/** File-name stem of published APKs. */
export const ANDROID_APK_STEM = 'memoriahub-android';

/** The Media Sync hub on the phone (`MediaSyncActivity`). */
export const MEDIA_SYNC_DEEP_LINK = `${ANDROID_DEEP_LINK_SCHEME}://media-sync`;

/** Screens of the native Media Sync activity (spec §12.2). */
export type MediaSyncDeepLinkPath =
  | 'connect'
  | 'paired'
  | 'folders'
  | 'network'
  | 'files'
  | 'diagnostics';

/** Actions the activity runs after opening (spec §12.2). */
export type MediaSyncDeepLinkAction = 'apply' | 'sync' | 'retry' | 'pause' | 'resume';

/**
 * `memoriahub://media-sync[/<path>][?action=<action>]`. Presentation only:
 * the link opens the phone's own screen, which acts with the phone's own
 * credential; the web grants nothing through it.
 */
export function mediaSyncDeepLink(
  path?: MediaSyncDeepLinkPath,
  action?: MediaSyncDeepLinkAction,
): string {
  const base = path ? `${MEDIA_SYNC_DEEP_LINK}/${path}` : MEDIA_SYNC_DEEP_LINK;
  return action ? `${base}?action=${action}` : base;
}

/** The download file name of a versioned APK: `memoriahub-android-<versionName>.apk`. */
export function androidApkFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.apk`;
}
