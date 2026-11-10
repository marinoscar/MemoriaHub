import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MEMORIAHUB_BRAND } from '../../src/brand/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '../..');
const identity = JSON.parse(readFileSync(resolve(PACKAGE, '../shared/identity.json'), 'utf8')) as {
  productName: string;
  tagline: string;
  themeColor: string;
  backgroundColor: string;
};

describe('brand', () => {
  it('carries the identity.json values', () => {
    expect(MEMORIAHUB_BRAND).toEqual({
      productName: identity.productName,
      tagline: identity.tagline,
      themeColor: identity.themeColor,
      backgroundColor: identity.backgroundColor,
    });
  });

  it('is in sync with the generated identity file', () => {
    // Fails with "src/brand/identity.ts is stale" after a rebrand until `npm run brand:sync` runs.
    expect(() => execFileSync('node', [resolve(PACKAGE, 'scripts/sync-brand-identity.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('ships the PWA icons byte-equal to the ones the web app serves', () => {
    const appPublic = resolve(PACKAGE, '../../apps/web/public');
    const pairs: Array<[string, string]> = [
      ['favicon.ico', 'favicon.ico'],
      ['favicon-16x16.png', 'favicon-16x16.png'],
      ['favicon-32x32.png', 'favicon-32x32.png'],
      ['apple-touch-icon.png', 'apple-touch-icon.png'],
      ['android-chrome-192x192.png', 'android-chrome-192x192.png'],
      ['android-chrome-512x512.png', 'android-chrome-512x512.png'],
      ...readdirSync(resolve(appPublic, 'icons')).map((f): [string, string] => [f, `icons/${f}`]),
    ];
    for (const [asset, served] of pairs) {
      const a = readFileSync(resolve(PACKAGE, 'src/brand/assets', asset));
      const b = readFileSync(resolve(appPublic, served));
      expect(a.equals(b), `${asset} drifted from apps/web/public/${served}`).toBe(true);
    }
  });
});
