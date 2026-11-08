// =============================================================================
// Verify the stored settings rows against the registered namespaces (RETRO-B3, #614)
// =============================================================================
//
// Run on a restored copy of production (NEVER writes):
//
//   npm run settings:verify --workspace=api
//
// Reads the `global` system_settings row and every user_settings row, and for each registered
// namespace reports:
//
//   FAIL  a stored leaf that fails its schema (the platform reads it as the default and the next write
//         stores the default: a value the schema would not accept today). Zero required.
//   NOTE  a namespace whose salvaged read differs from what is stored (a missing leaf the platform fills
//         from the defaults, a legacy `profile` rewritten to the platform shape, an unmodelled key that
//         the platform carries forward untouched, a stored top-level user key no namespace owns, which
//         the next write DROPS). Informational: nothing here changes a value an admin or user chose.
//
// Exit code 1 when there is any FAIL. Values are never printed, only paths (they may hold secrets).
// =============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
import { Client } from 'pg';

import { systemSettingsNamespaceRegistry, userSettingsNamespaceRegistry } from '@marinoscar/platform-api/settings';
import '../src/settings/registry';

config({ path: resolve(__dirname, '..', '.env') });
config({ path: resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env') });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Paths of stored leaves that fail the schema, walking object schemas like the namespace `read` does. */
function failingLeaves(schema: unknown, stored: unknown, path: string): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape && isObject(stored)) {
    return Object.entries(shape).flatMap(([key, child]) =>
      stored[key] === undefined ? [] : failingLeaves(child, stored[key], `${path}.${key}`),
    );
  }
  const result = (schema as { safeParse(v: unknown): { success: boolean } }).safeParse(stored);
  return result.success ? [] : [path];
}

async function main(): Promise<void> {
  const url =
    process.env['DATABASE_URL'] ??
    `postgresql://${process.env['POSTGRES_USER'] ?? 'postgres'}:${encodeURIComponent(process.env['POSTGRES_PASSWORD'] ?? 'postgres')}@${process.env['POSTGRES_HOST'] ?? 'localhost'}:${process.env['POSTGRES_PORT'] ?? '5432'}/${process.env['POSTGRES_DB'] ?? 'appdb'}`;
  const client = new Client({ connectionString: url });
  await client.connect();

  const failures: string[] = [];
  const notes: string[] = [];

  try {
    // ---- system -------------------------------------------------------------
    const system = await client.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE key = 'global'`);
    const root = isObject(system.rows[0]?.value) ? (system.rows[0]!.value as Record<string, unknown>) : undefined;
    if (!root) failures.push('system_settings.global: row missing or not an object');
    for (const ns of systemSettingsNamespaceRegistry.list()) {
      const stored = root?.[ns.key];
      if (stored === undefined) {
        notes.push(`system.${ns.key}: absent (reads as the defaults)`);
        continue;
      }
      for (const path of failingLeaves(ns.storedSchema, stored, ns.key)) failures.push(`system.${path}: stored value fails its schema`);
      const read = ns.read ? ns.read(stored, { asPlainObject: () => undefined, readNamespace: () => ({}), readStringArray: () => [] } as never) : stored;
      if (isObject(stored) && isObject(read)) {
        const extra = Object.keys(stored).filter((k) => !(k in read));
        if (extra.length > 0) notes.push(`system.${ns.key}: unmodelled key(s) carried forward untouched: ${extra.join(', ')}`);
      }
      if (JSON.stringify(read) !== JSON.stringify(stored) && isObject(stored) && Object.keys(stored).every((k) => k in (read as object))) {
        notes.push(`system.${ns.key}: a read fills or normalises a leaf (the next write stores the completed value)`);
      }
    }

    // ---- user ---------------------------------------------------------------
    const owned = new Set(['theme', 'profile', ...userSettingsNamespaceRegistry.list().map((n) => n.key)]);
    const users = await client.query<{ user_id: string; value: unknown }>(`SELECT user_id, value FROM user_settings`);
    const dropped = new Map<string, number>();
    let legacyProfiles = 0;
    for (const row of users.rows) {
      if (!isObject(row.value)) {
        failures.push(`user_settings(${row.user_id}): value is not an object`);
        continue;
      }
      const value = row.value;
      if (isObject(value['profile']) && 'useProviderImage' in (value['profile'] as object)) legacyProfiles++;
      for (const key of Object.keys(value)) if (!owned.has(key)) dropped.set(key, (dropped.get(key) ?? 0) + 1);
      for (const ns of userSettingsNamespaceRegistry.list()) {
        if (value[ns.key] === undefined) continue;
        const parsed = ns.schema.safeParse(value[ns.key]);
        if (!parsed.success) {
          // A removed navigation destination is read-sanitised, not a failure.
          const sanitised = ns.key === 'navigation';
          (sanitised ? notes : failures).push(`user_settings(${row.user_id}).${ns.key}: stored value fails its schema${sanitised ? ' (navigation pins are sanitised on read)' : ''}`);
        }
      }
    }
    if (legacyProfiles > 0) notes.push(`user.profile: ${legacyProfiles} row(s) in the pre-platform shape (useProviderImage); the next write stores the platform shape`);
    for (const [key, count] of dropped) notes.push(`user.${key}: ${count} row(s) hold a top-level key no namespace owns; the next write drops it`);

    console.log(`system_settings.global: ${root ? Object.keys(root).length : 0} namespace(s) stored; user_settings: ${users.rowCount} row(s)`);
  } finally {
    await client.end();
  }

  for (const note of notes) console.log(`NOTE  ${note}`);
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  console.log(`${failures.length} failure(s), ${notes.length} note(s)`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
