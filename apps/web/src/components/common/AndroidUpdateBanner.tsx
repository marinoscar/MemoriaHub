/**
 * "A newer Android app is available" (issue #515), the platform's banner since
 * RETRO-D5 (#586). Shown only inside the app's Trusted Web Activity when the
 * installed build (from the TWA launch URL) is older than the hosted release;
 * an ordinary tab renders nothing and asks nothing of the API. Bound to
 * MemoriaHub's key prefix, so the session keys and the per-versionCode dismissal
 * (`memoriahub.androidUpdate.dismissedVersionCode`) are the ones it always used,
 * and to the user download page for "Details".
 */
import { AndroidUpdateBanner as PlatformAndroidUpdateBanner } from '@marinoscar/platform-web/android-app/ui';

import { TWA_KEY_PREFIX } from '../../platform/android-app/identity';
import { ANDROID_APP_SETTINGS_PATH } from '@marinoscar/memoriahub-web/media-sync/headless';

/** Where the dismissed versionCode is remembered (same key as before the platform banner). */
export const ANDROID_UPDATE_DISMISSED_KEY = `${TWA_KEY_PREFIX}.androidUpdate.dismissedVersionCode`;

export function AndroidUpdateBanner() {
  return <PlatformAndroidUpdateBanner keyPrefix={TWA_KEY_PREFIX} detailsPath={ANDROID_APP_SETTINGS_PATH} />;
}
