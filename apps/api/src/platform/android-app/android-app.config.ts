// =============================================================================
// The android-app slice composition (RETRO-D5, #586)
// =============================================================================
//
// `AndroidAppModule.forRoot` serves what `apps/api/src/android-app/` used to:
// the trusted Android apps (`android_app` system-settings row, same key and
// shape) and the public `/api/well-known/assetlinks.json` (a bare array,
// maintenance-exempt, byte-identical to the app's), the hosted APK releases
// (`android_app_releases`, `android-releases/<id>.apk`, signed same-origin
// download links), the admin test notification, the `android_app` notification
// sender and the Doctor checks `android.assetlinks` / `android.releases`.
//
// Registrations it needs before it composes (import order matters):
//   - the Media Sync device source (`media-sync/media-sync.device-source.ts`),
//     imported first below: the admin page's reported apps and the two Doctor
//     checks read `media_sync_devices` through it;
//   - the `android_app` notification channel (`notification.manifest.ts`);
//   - the `android-releases/` key prefix (`storage-key-prefix.manifest.ts`,
//     the slice's own `ANDROID_RELEASES_KEY_PREFIX_DEF`).
//
// Identity: `appName` is the product name and `apkStem` comes from the
// `android` block of `packages/shared/identity.json` (`memoriahub-android`), so
// a downloaded APK keeps its file name (`memoriahub-android-<versionName>.apk`).
// =============================================================================

import '../../media-sync/media-sync.device-source';

import { IDENTITY, PRODUCT_NAME } from '@app/shared';
import { AndroidAppModule } from '@marinoscar/platform-api/android-app';
import { androidIdentity } from '@marinoscar/platform-contract/android-app';

/** The Android identity derived from `identity.json` (its `android` block wins). */
export const ANDROID_IDENTITY = androidIdentity({
  productName: IDENTITY.productName,
  repoSlug: IDENTITY.repoSlug,
  android: IDENTITY.android,
});

export const androidAppModule = AndroidAppModule.forRoot({
  appName: PRODUCT_NAME,
  apkStem: ANDROID_IDENTITY.apkStem,
  testNotificationLink: '/',
});
