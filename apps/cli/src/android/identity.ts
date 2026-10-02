/**
 * android/identity.ts — apps/android/identity.properties (issue #517).
 *
 * The product identity the Gradle build, the CLI and CI all read:
 * `applicationId` (the release package name, case-sensitive) and `apkStem`
 * (the published file name stem). The defaults mirror the committed file, so
 * `publish <apk>` outside a checkout still names things correctly.
 */

import { existsSync, readFileSync } from 'node:fs';

import { identityPropertiesPath } from './paths.js';
import { parseProperties } from './version.js';

export const DEFAULT_APPLICATION_ID = 'memoriahub.marin.cr';
export const DEFAULT_APK_STEM = 'memoriahub-android';

export interface AndroidIdentity {
  applicationId: string;
  apkStem: string;
}

export function readIdentity(repoRoot: string | undefined): AndroidIdentity {
  const fallback: AndroidIdentity = { applicationId: DEFAULT_APPLICATION_ID, apkStem: DEFAULT_APK_STEM };
  if (repoRoot === undefined) return fallback;
  const file = identityPropertiesPath(repoRoot);
  if (!existsSync(file)) return fallback;
  const props = parseProperties(readFileSync(file, 'utf8'));
  return {
    applicationId: props.get('applicationId') || fallback.applicationId,
    apkStem: props.get('apkStem') || fallback.apkStem,
  };
}

/** `memoriahub-android-2.0.1.apk` (debug: `…-2.0.1-debug.apk`). */
export function apkFileName(identity: AndroidIdentity, versionName: string, debug = false): string {
  return `${identity.apkStem}-${versionName}${debug ? '-debug' : ''}.apk`;
}
