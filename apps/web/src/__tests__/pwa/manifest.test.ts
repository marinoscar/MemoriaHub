import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_COLOR,
  MANIFEST_APP_NAME,
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  THEME_COLOR,
  buildManifest,
} from '../../../pwa/manifest';
import { APP_NAME } from '../../constants/app';
import { lightPalette } from '../../theme/light';

// =============================================================================
// The web app manifest  (issue #482, epic #481)
// =============================================================================
//
// Two invariants nothing else enforces:
//
//   1. The manifest's brand values agree with the app's. `pwa/manifest.ts`
//      cannot import them (see its header — composite-project rules), so they
//      are copies, and this suite is what keeps the copies honest.
//
//   2. Every icon `src` names a file that exists. Vite copies `public/`
//      verbatim and never validates manifest paths, so a renamed icon would
//      first show up as a platform silently refusing to install the app.
// =============================================================================

const webRoot = resolve(__dirname, '..', '..', '..');
const publicFile = (src: string) => resolve(webRoot, 'public', src.replace(/^\//, ''));

describe('buildManifest', () => {
  it('uses the same product name the app renders', () => {
    const manifest = buildManifest();

    expect(MANIFEST_APP_NAME).toBe(APP_NAME);
    expect(manifest.name).toBe(APP_NAME);
    expect(manifest.short_name).toBe(APP_NAME);
  });

  it('declares standalone display, which is what iOS reads to allow installation', () => {
    // Safari grants Notifications / Push only to a Home Screen web app, and it
    // only offers that for a manifest requesting standalone.
    expect(buildManifest().display).toBe('standalone');
  });

  it('paints OS chrome in the app primary colour, matching index.html', () => {
    const manifest = buildManifest();
    const primary = lightPalette.primary as { main: string };

    expect(manifest.theme_color).toBe(THEME_COLOR);
    expect(THEME_COLOR).toBe(primary.main);
    expect(manifest.background_color).toBe(BACKGROUND_COLOR);

    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf-8');
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR}" />`);
  });

  it('scopes the app to the site root with a stable id', () => {
    const manifest = buildManifest();

    expect(manifest.id).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url).toBe('/');
  });

  it('references only icons that exist in public/', () => {
    const icons = buildManifest().icons;
    expect(icons.length).toBeGreaterThan(0);

    const missing = icons.map((icon) => icon.src).filter((src) => !existsSync(publicFile(src)));

    expect(missing, `manifest icons with no file under apps/web/public: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('offers the icon purposes each install surface needs', () => {
    const purposes = new Set(buildManifest().icons.map((icon) => icon.purpose));

    // `any` is the launcher icon, `maskable` is what Android crops into its
    // adaptive shape, and `monochrome` is the push notification's status-bar
    // badge.
    expect(purposes).toEqual(new Set(['any', 'maskable', 'monochrome']));
  });

  it('includes 192 and 512 icons for both any and maskable', () => {
    const icons = buildManifest().icons;
    for (const purpose of ['any', 'maskable'] as const) {
      const sizes = icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
      expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    }
  });

  it('gives every icon a size and a declared MIME type', () => {
    for (const icon of buildManifest().icons) {
      expect(icon.sizes, `${icon.src} has no sizes`).toMatch(/^\d+x\d+$/);
      expect(icon.type, `${icon.src} has no type`).toBe('image/png');
    }
  });

  it('keeps the notification icon/badge the service worker uses on disk and in step with sw.ts', () => {
    expect(existsSync(publicFile(NOTIFICATION_ICON))).toBe(true);
    expect(existsSync(publicFile(NOTIFICATION_BADGE))).toBe(true);

    const sw = readFileSync(resolve(webRoot, 'src', 'sw.ts'), 'utf-8');
    expect(sw).toContain(`const PUSH_ICON = '${NOTIFICATION_ICON}';`);
    expect(sw).toContain(`const PUSH_BADGE = '${NOTIFICATION_BADGE}';`);
  });

  it('is serialisable as the JSON the build emits', () => {
    expect(() => JSON.parse(JSON.stringify(buildManifest()))).not.toThrow();
  });
});
