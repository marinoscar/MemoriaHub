/**
 * `utils/androidIdentity.ts` mirrors `apps/android/identity.properties`
 * (issue #515, spec §2). The web build cannot read the properties file, so
 * the values are copies; this suite reads the file and fails when they drift.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_APK_STEM,
  ANDROID_DEEP_LINK_SCHEME,
  ANDROID_PACKAGE_NAME,
  MEDIA_SYNC_DEEP_LINK,
  androidApkFileName,
  mediaSyncDeepLink,
} from '../../utils/androidIdentity';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROPERTIES_PATH = resolve(HERE, '../../../../android/identity.properties');

function readProperties(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const props = readProperties(PROPERTIES_PATH);

describe('androidIdentity mirrors apps/android/identity.properties', () => {
  it('uses the same applicationId, exactly as cased', () => {
    expect(props.applicationId).toBe('memoriahub.marin.cr');
    expect(ANDROID_PACKAGE_NAME).toBe(props.applicationId);
  });

  it('uses the same deep-link scheme', () => {
    expect(ANDROID_DEEP_LINK_SCHEME).toBe(props.deepLinkScheme);
    expect(MEDIA_SYNC_DEEP_LINK).toBe(`${props.deepLinkScheme}://media-sync`);
  });

  it('uses the same APK stem', () => {
    expect(ANDROID_APK_STEM).toBe(props.apkStem);
    expect(androidApkFileName('2.0.0')).toBe(`${props.apkStem}-2.0.0.apk`);
  });
});

describe('mediaSyncDeepLink', () => {
  it('builds the hub, screen and action links', () => {
    expect(mediaSyncDeepLink()).toBe('memoriahub://media-sync');
    expect(mediaSyncDeepLink(undefined, 'apply')).toBe('memoriahub://media-sync?action=apply');
    expect(mediaSyncDeepLink('files')).toBe('memoriahub://media-sync/files');
    expect(mediaSyncDeepLink('diagnostics', 'sync')).toBe(
      'memoriahub://media-sync/diagnostics?action=sync',
    );
  });
});
