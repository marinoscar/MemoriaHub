/**
 * `config/shell.ts` — the one navigation object the packaged shell reads
 * (RETRO-F1, #571).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { APP_NAVIGATION, DESTINATIONS, PHONE_BAR_NAVIGATION } from '../../config/shell';
import { DESTINATION_ROUTES } from '../../config/destinations';
import { ADMIN_HUB_PATH } from '../../config/adminSections';
import { USER_HUB_PATH } from '../../config/userSettingsSections';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(resolve(HERE, '../../../../api/prisma/catalog/permissions.json'), 'utf8'),
) as { permissions: { name: string }[] };
const API_PERMISSIONS = new Set(catalog.permissions.map((p) => p.name));

describe('APP_NAVIGATION', () => {
  it('declares one destination per destination key, in navigation order', () => {
    expect(DESTINATIONS.map((d) => d.key)).toEqual(['photos', 'collections', 'search', 'review', 'console']);
    expect(Object.keys(DESTINATION_ROUTES).sort()).toEqual(DESTINATIONS.map((d) => d.key).sort());
  });

  it('every destination path is owned by its own destination', () => {
    for (const destination of DESTINATIONS) {
      const prefixes = DESTINATION_ROUTES[destination.key];
      expect(
        prefixes.some((prefix) => destination.path === prefix || destination.path.startsWith(`${prefix}/`)),
        destination.key,
      ).toBe(true);
    }
  });

  it('gates the Console on a real API permission and pins it at the rail foot', () => {
    const console = DESTINATIONS.find((d) => d.key === 'console')!;
    expect(console.pinned).toBe(true);
    expect(console.path).toBe(ADMIN_HUB_PATH);
    expect(API_PERMISSIONS.has(console.permission!)).toBe(true);
  });

  it('gives Review its badge and Collections / Review their context panes', () => {
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.review.badge).toBeTypeOf('function');
    expect(byKey.review.contextPane).toBeTypeOf('function');
    expect(byKey.collections.contextPane).toBeTypeOf('function');
    expect(byKey.photos.contextPane).toBeUndefined();
    expect(byKey.search.contextPane).toBeUndefined();
  });

  it('drills into both settings surfaces and runs Console mode under /admin', () => {
    expect(APP_NAVIGATION.settingsSurfaces?.map((s) => s.hubPath)).toEqual([ADMIN_HUB_PATH, USER_HUB_PATH]);
    expect(APP_NAVIGATION.console?.prefix).toBe('/admin');
  });

  it('keeps the phone bar to the four non-pinned destinations', () => {
    expect(PHONE_BAR_NAVIGATION.destinations.map((d) => d.key)).toEqual([
      'photos',
      'collections',
      'search',
      'review',
    ]);
  });
});
