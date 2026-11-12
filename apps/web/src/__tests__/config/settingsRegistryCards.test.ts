/**
 * The settings registries, card by card (RETRO-J11, #626).
 *
 * `ADMIN_SECTIONS` and `USER_SETTINGS_SECTIONS` are the one declaration the hub, the console rail and the
 * app bar read, and several of their cards are now spread from the packaged slices
 * (`@marinoscar/memoriahub-web/shell` and the platform slices). Moving a page into a package must not move,
 * rename, regate or reorder a card, so this file pins the whole catalog: section, order, route, the exact
 * permission string the API enforces and the feature gate (Settings UI Pattern, AGENTS.md). A card that
 * is added, removed or regated fails here and is changed on purpose, with its controller.
 *
 * A second test reads the API sources and fails when a card names a permission no controller or
 * guard declares: an invented string would hide the card from everyone, or show it to all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from '../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

type Expected = { section: string; cards: { path: string; permission?: string; feature?: string }[] }[];

const EXPECTED_ADMIN: Expected = [
  { section: "General", cards: [
    { path: "/admin/settings/general", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/users", permission: "users:read", feature: undefined },
    { path: "/admin/settings/archiving", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/email", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/push", permission: "push:read", feature: undefined },
    { path: "/admin/settings/notifications", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/android", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/setup", permission: "system_settings:read", feature: undefined },
  ] },
  { section: "AI & Enrichment", cards: [
    { path: "/admin/settings/ai", permission: "ai_config:read", feature: undefined },
    { path: "/admin/settings/tagging", permission: "ai_config:read", feature: undefined },
    { path: "/admin/settings/face", permission: "face_settings:read", feature: undefined },
    { path: "/admin/settings/bursts", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/duplicates", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/enhancer", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/memories", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/social-media", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/ai/models", permission: "ai_config:read", feature: "ai" },
    { path: "/admin/settings/ai/usage", permission: "ai_config:read", feature: "ai" },
  ] },
  { section: "Media", cards: [
    { path: "/admin/settings/geo", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/location-inference", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/location-groups", permission: "geo_settings:read", feature: undefined },
  ] },
  { section: "Storage", cards: [
    { path: "/admin/settings/storage", permission: "storage_config:read", feature: undefined },
    { path: "/admin/settings/storage/insights", permission: "system_settings:read", feature: undefined },
  ] },
  { section: "Operations", cards: [
    { path: "/admin/settings/jobs", permission: "jobs:read", feature: undefined },
    { path: "/admin/settings/jobs/insights", permission: "jobs:read", feature: undefined },
    { path: "/admin/settings/workers", permission: "nodes:read", feature: undefined },
    { path: "/admin/settings/db-backup", permission: "db_backup:read", feature: undefined },
    { path: "/admin/settings/sharing", permission: "sharing:admin", feature: undefined },
    { path: "/admin/settings/workflows", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/doctor", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/broadcasts", permission: "broadcasts:read", feature: undefined },
    { path: "/admin/settings/maintenance", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/about", permission: "system_settings:read", feature: undefined },
    { path: "/admin/settings/telemetry", permission: "telemetry:read", feature: undefined },
    { path: "/admin/settings/telemetry/explorer", permission: "telemetry:query", feature: "telemetry" },
    { path: "/admin/settings/telemetry/dashboard", permission: "telemetry:query", feature: "telemetry" },
    { path: "/admin/settings/alerts", permission: "alerts:read", feature: undefined },
    { path: "/admin/settings/webhooks", permission: "system_webhooks:read", feature: undefined },
    { path: "/admin/settings/data-export", permission: "org_members:read", feature: undefined },
  ] },
  { section: "Danger Zone", cards: [
    { path: "/admin/settings/factory-reset", permission: "system:factory_reset", feature: undefined },
  ] },
];

const EXPECTED_USER: Expected = [
  { section: "Account", cards: [
    { path: "/settings/profile", permission: undefined, feature: undefined },
    { path: "/settings/appearance", permission: undefined, feature: undefined },
    { path: "/settings/time-zone", permission: undefined, feature: undefined },
    { path: "/settings/notifications", permission: undefined, feature: undefined },
    { path: "/settings/memories", permission: undefined, feature: undefined },
    { path: "/settings/search", permission: undefined, feature: undefined },
    { path: "/settings/getting-started", permission: undefined, feature: undefined },
  ] },
  { section: "Android", cards: [
    { path: "/settings/android-app", permission: undefined, feature: undefined },
    { path: "/settings/media-sync", permission: "media:read", feature: undefined },
  ] },
  { section: "Security", cards: [
    { path: "/settings/tokens", permission: undefined, feature: undefined },
  ] },
  { section: "Integrations", cards: [
    { path: "/settings/webhooks", permission: "webhooks:read", feature: undefined },
  ] },
  { section: "Sharing", cards: [
    { path: "/settings/groups", permission: "groups:read", feature: undefined },
  ] },
  { section: "Your data", cards: [
    { path: "/settings/data-export", permission: undefined, feature: undefined },
  ] },
  { section: "Danger Zone", cards: [
    { path: "/settings/danger-zone", permission: undefined, feature: undefined },
  ] },
];

const describeSections = (sections: typeof ADMIN_SECTIONS) =>
  sections.map((section) => ({
    section: section.label,
    cards: section.cards.map((card) => ({
      path: card.path as string,
      permission: card.permission as string | undefined,
      feature: card.feature as string | undefined,
    })),
  }));

describe('settings registry card equality', () => {
  it('the admin registry holds exactly the expected sections, cards, routes, permissions and features, in order', () => {
    expect(describeSections(ADMIN_SECTIONS)).toEqual(EXPECTED_ADMIN);
  });

  it('the per-user registry holds exactly the expected sections, cards, routes, permissions and features, in order', () => {
    expect(describeSections(USER_SETTINGS_SECTIONS)).toEqual(EXPECTED_USER);
  });

  it('no two cards share a route', () => {
    const paths = [...EXPECTED_ADMIN, ...EXPECTED_USER].flatMap((s) => s.cards.map((c) => c.path));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

/** Every source file under `dir`, skipping tests and build output the API's guards do not live in. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'test' || name === '__tests__') continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|js)$/.test(name) && !/\.(spec|test)\./.test(name) && !name.endsWith('.map')) out.push(full);
  }
  return out;
}

describe('settings registry permissions', () => {
  it('every permission a card names is declared by the API (a controller, a guard or the permission catalog)', () => {
    const roots = [
      join(repoRoot, 'apps/api/src'),
      join(repoRoot, 'packages/memoriahub-api/src'),
      join(repoRoot, 'node_modules/@marinoscar/platform-api/dist'),
    ];
    const haystack = roots.flatMap((root) => sourceFiles(root)).map((file) => readFileSync(file, 'utf8')).join('\n');
    // Not vacuous: the three roots hold the API's sources.
    expect(haystack.length).toBeGreaterThan(100_000);
    const names = new Set<string>();
    for (const section of [...EXPECTED_ADMIN, ...EXPECTED_USER]) {
      for (const card of section.cards) if (card.permission) names.add(card.permission);
    }
    const missing = [...names].filter((name) => !haystack.includes(`'${name}'`) && !haystack.includes(`"${name}"`));
    expect(missing).toEqual([]);
  });
});
