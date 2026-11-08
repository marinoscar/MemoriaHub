/**
 * `packages/shared/identity.json` is the product identity. Until the Android
 * Gradle build reads it (RETRO-D5), `apps/android/identity.properties` still
 * feeds the build, so this suite fails when the two disagree. It also pins the
 * brand colours to the web manifest constants.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_COLOR, THEME_COLOR } from '../../pwa/manifest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

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

const identity = JSON.parse(
  readFileSync(resolve(ROOT, 'packages/shared/identity.json'), 'utf-8'),
) as {
  productName: string;
  themeColor: string;
  backgroundColor: string;
  cliName: string;
  android: {
    applicationId: string;
    storagePrefix: string;
    deepLinkScheme: string;
    apkStem: string;
  };
};
const props = readProperties(resolve(ROOT, 'apps/android/identity.properties'));

describe('packages/shared/identity.json', () => {
  it('matches apps/android/identity.properties', () => {
    expect(identity.android.applicationId).toBe(props.applicationId);
    expect(identity.android.storagePrefix).toBe(props.storagePrefix);
    expect(identity.android.deepLinkScheme).toBe(props.deepLinkScheme);
    expect(identity.android.apkStem).toBe(props.apkStem);
    expect(identity.productName).toBe(props.productName);
    expect(identity.themeColor).toBe(props.themeColor);
    expect(identity.backgroundColor).toBe(props.backgroundColor);
  });

  it('matches the web manifest colours', () => {
    expect(identity.themeColor).toBe(THEME_COLOR);
    expect(identity.backgroundColor).toBe(BACKGROUND_COLOR);
  });

  it('keeps the CLI name', () => {
    expect(identity.cliName).toBe('memoriahub');
  });
});
