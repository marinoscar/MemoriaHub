/**
 * The Android companion's identity on the web (RETRO-D5, #586).
 *
 * Read from the `android` block of `packages/shared/identity.json` through the
 * platform's `androidIdentity` (the single source since RETRO-A2), replacing the
 * hand-copied `utils/androidIdentity.ts`. Presentation only: the web never calls
 * native code (no JavaScript bridge); these values name the app in links and
 * file names.
 *
 * - `applicationId` (`memoriahub.marin.cr`) is case-sensitive and never changes
 *   for a shipped app; the debug build appends `.debug`.
 * - `deepLinkScheme` (`memoriahub`) builds the `memoriahub://media-sync` links
 *   the Media Sync page offers on a phone.
 * - `storagePrefix` (`memoriahub`) is also the prefix of the TWA session keys
 *   (`memoriahub.twa`, ...), so a launch captured before the cutover still reads.
 * - `apkStem` names a downloaded APK, `<apkStem>-<versionName>.apk`.
 *
 * `apps/web/src/__tests__/platform/androidIdentity.test.ts` fails when this
 * drifts from `identity.json` or from `apps/android/identity.properties` (which
 * the Gradle build still reads).
 */
import { androidIdentity } from '@marinoscar/platform-web/android-app/headless';

import identityJson from '../../../../../packages/shared/identity.json';

/** The resolved identity (the `android` block wins over the derived defaults). */
export const ANDROID_IDENTITY = androidIdentity({
  productName: identityJson.productName,
  repoSlug: identityJson.repoSlug,
  android: identityJson.android,
});

export const ANDROID_PACKAGE_NAME = ANDROID_IDENTITY.applicationId;

/**
 * The retired v1 app's package: a different application users uninstall by
 * hand. Kept only so the download page can tell them; never grep-replace it.
 */
export const LEGACY_ANDROID_PACKAGE_NAME = 'cr.marin.memoriahub';

export const ANDROID_DEEP_LINK_SCHEME = ANDROID_IDENTITY.deepLinkScheme;

export const ANDROID_APK_STEM = ANDROID_IDENTITY.apkStem;

/** The prefix of the TWA session keys: the on-device storage prefix. */
export const TWA_KEY_PREFIX = ANDROID_IDENTITY.storagePrefix;

/** The Media Sync deep-link root, `memoriahub://media-sync`. */
export const MEDIA_SYNC_DEEP_LINK = `${ANDROID_DEEP_LINK_SCHEME}://media-sync`;

export type MediaSyncDeepLinkPath = 'connect' | 'paired' | 'folders' | 'network' | 'files' | 'diagnostics';

export type MediaSyncDeepLinkAction = 'apply' | 'sync' | 'retry' | 'pause' | 'resume';

/** A Media Sync deep link (spec §11.2): `memoriahub://media-sync[/<path>][?action=<action>]`. */
export function mediaSyncDeepLink(path?: MediaSyncDeepLinkPath, action?: MediaSyncDeepLinkAction): string {
  const base = path ? `${MEDIA_SYNC_DEEP_LINK}/${path}` : MEDIA_SYNC_DEEP_LINK;
  return action ? `${base}?action=${action}` : base;
}

/** The file name of a published APK. */
export function androidApkFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.apk`;
}
