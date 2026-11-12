/**
 * The Android port of the web edition's `MemoriahubWebHost` (RETRO-J11, #626): what the
 * packaged Media Sync and Android download pages ask their host for. The identity
 * (`ANDROID_IDENTITY`, read from `packages/shared/identity.json` and checked against
 * `apps/android/identity.properties` by `__tests__/platform/androidIdentity.test.ts`), the TWA
 * helpers and the release and download-link hooks are the platform android-app slice's,
 * bound to MemoriaHub's identity. Presentation only, never authorization.
 */
import { useAndroidAppClient, useAndroidRelease } from '@marinoscar/platform-web/android-app/headless';
import type { MemoriahubAndroidPort } from '@marinoscar/memoriahub-web/core/headless';

import { APP_NAME } from '../constants/app';
import { LEGACY_ANDROID_PACKAGE_NAME, mediaSyncDeepLink } from '../platform/android-app/identity';
import { getInstalledAppVersion, isRunningInTwa } from '../platform/android-app/twa';

/** The Android port of the web edition. */
export const appMemoriahubAndroid: MemoriahubAndroidPort = {
  appName: APP_NAME,
  legacyPackageName: LEGACY_ANDROID_PACKAGE_NAME,
  mediaSyncDeepLink,
  isRunningInTwa,
  getInstalledAppVersion,
  useAndroidRelease: () => useAndroidRelease(),
  useAndroidDownloadLink: useAndroidAppClient,
};
