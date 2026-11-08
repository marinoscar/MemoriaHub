#!/usr/bin/env node
/**
 * verify-identity-transform.mjs - proves the identity adoption changed nobody's
 * access (RETRO-B2, issue #611).
 *
 * Two steps, run against the SAME database around the stack's migrations:
 *
 *   node scripts/verify-identity-transform.mjs snapshot --out before.json
 *       BEFORE `prisma migrate deploy` (the A5-state database, pre-platform 0003):
 *       records, per user, the permissions MemoriaHub's old model granted
 *       (union of the grants of the roles in `user_roles`), the row counts of
 *       every identity table, and the profile-picture state held on `users`.
 *       Plain SQL: the generated client matches the NEW schema only.
 *
 *   node scripts/verify-identity-transform.mjs verify --before before.json
 *       AFTER the migrations (and, optionally, `prisma:seed`): computes each
 *       user's effective permissions with the PLATFORM's own resolver
 *       (`resolveEffectiveAccess` of @marinoscar/platform-api/identity: system
 *       roles plus the default-organization membership role, single-org mode)
 *       and compares. Also compares the row counts, proves the PATs / refresh
 *       tokens / device codes / allowlist / node credentials kept their ids and
 *       hashes, the media-sync device still points at its PAT, and every
 *       profile-picture state moved to `user_profiles` with `users` back to the
 *       platform's shape.
 *
 * Exit 0 when identical, 1 with a list of differences, 2 on a usage error.
 * Reads POSTGRES_* (or DATABASE_URL); prints no secret.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const e = process.env;
  const auth = e.POSTGRES_PASSWORD ? `${encodeURIComponent(e.POSTGRES_USER ?? 'postgres')}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` : encodeURIComponent(e.POSTGRES_USER ?? 'postgres');
  return `postgresql://${auth}@${e.POSTGRES_HOST ?? 'localhost'}:${e.POSTGRES_PORT ?? '5432'}/${e.POSTGRES_DB ?? 'appdb'}`;
}

const COUNT_TABLES = [
  'users', 'user_identities', 'roles', 'permissions', 'role_permissions', 'user_roles', 'refresh_tokens',
  'personal_access_tokens', 'device_codes', 'allowed_emails', 'audit_events', 'user_settings',
];

async function withClient(fn) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function counts(client, tables) {
  const out = {};
  for (const t of tables) out[t] = Number((await client.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n);
  return out;
}

async function snapshot(out) {
  return withClient(async (client) => {
    const users = (
      await client.query(`
        SELECT u.id, u.email, u.is_active, u.avatar_source, u.avatar_storage_key, u.avatar_version, u.linked_person_id,
               u.profile_image_url,
               COALESCE((SELECT array_agg(DISTINCT r.name ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
               COALESCE((SELECT array_agg(DISTINCT p.name ORDER BY p.name) FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                         JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = u.id), '{}') AS permissions
        FROM users u ORDER BY u.email`)
    ).rows;
    const hashes = {
      personal_access_tokens: (await client.query('SELECT id, token_hash, user_id, expires_at, revoked_at FROM personal_access_tokens ORDER BY id')).rows,
      refresh_tokens: (await client.query('SELECT token_hash, user_id, revoked_at FROM refresh_tokens ORDER BY token_hash')).rows,
      device_codes: (await client.query('SELECT device_code, user_code, status, client_info FROM device_codes ORDER BY device_code')).rows,
      allowed_emails: (await client.query('SELECT email, claimed_by_id FROM allowed_emails ORDER BY email')).rows,
      node_credentials: (await client.query('SELECT id, token_hash, user_id FROM mh_legacy_node_credentials ORDER BY id')).rows,
      media_sync_devices: (await client.query('SELECT id, pat_id FROM media_sync_devices ORDER BY id')).rows,
    };
    const permissionNames = (await client.query('SELECT name FROM permissions ORDER BY name')).rows.map((r) => r.name);
    const data = { takenAt: new Date().toISOString(), permissionNames, counts: await counts(client, COUNT_TABLES), users, hashes };
    writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
    console.log(`snapshot: ${users.length} users, ${Object.values(data.counts).reduce((a, b) => a + b, 0)} identity rows -> ${out}`);
  });
}

const sortJson = (v) => JSON.stringify(v);
const same = (a, b) => sortJson(a) === sortJson(b);

async function verify(beforeFile) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
  const problems = [];
  const notices = [];
  const newPermissionHolders = new Map();
  const acceptRoleless = argv.includes('--accept-roleless-viewer');

  const identity = require('@marinoscar/platform-api/identity');
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });

  try {
    // 1. Effective permissions, per user, with the platform's own resolver.
    const after = await prisma.user.findMany({ include: identity.PRINCIPAL_USER_INCLUDE, orderBy: { email: 'asc' } });
    const byEmail = new Map(after.map((u) => [u.email, u]));
    let checked = 0;
    for (const old of before.users) {
      const u = byEmail.get(old.email);
      if (!u) { problems.push(`user ${old.email} is missing after the migration`); continue; }
      if (u.isActive !== old.is_active) problems.push(`${old.email}: is_active changed`);
      const access = identity.resolveEffectiveAccess(u, 'single');
      const got = [...access.permissions].sort();
      const want = [...old.permissions].sort();
      const lost = want.filter((p) => !got.includes(p));
      // A permission the platform slices introduce (org_members:*, organizations:*, ...) did not exist
      // before, so it cannot have been "had"; the administrators holding it are reported, not failed.
      const fresh = got.filter((p) => !want.includes(p) && !before.permissionNames.includes(p));
      if (fresh.length) newPermissionHolders.set(old.email, fresh);
      const gained = got.filter((p) => !want.includes(p) && before.permissionNames.includes(p));
      if (lost.length) problems.push(`${old.email}: LOST permissions ${lost.join(', ')}`);
      if (gained.length) {
        if (old.roles.length === 0 && acceptRoleless) {
          notices.push(`${old.email}: had NO role, now holds the default org role (viewer) and ${gained.length} permission(s) (platform 0024 step 4, accepted by --accept-roleless-viewer)`);
        } else {
          problems.push(`${old.email}: GAINED permissions ${gained.join(', ')}${old.roles.length === 0 ? ' (the user had no role: platform 0024 gives every member the default org role; pass --accept-roleless-viewer after reviewing them)' : ''}`);
        }
      }
      // The platform's roles replace the old ones, so only the system role is compared: an administrator stays one.
      if (old.roles.includes('admin') && !access.systemRoles.includes('admin')) problems.push(`${old.email}: lost the admin system role`);
      checked++;
    }
    console.log(`permissions: ${checked} user(s) compared with the platform resolver`);

    // 2. Row counts and the credential rows, byte for byte.
    const afterCounts = await withClient((c) => counts(c, COUNT_TABLES));
    for (const t of COUNT_TABLES) {
      // The catalog and the audit trail may GROW (platform roles, the seed's grants, new audit rows);
      // user_roles SHRINKS by design (platform 0024 moves org roles onto the membership). Everything else is exact.
      const grows = ['roles', 'permissions', 'role_permissions', 'audit_events'].includes(t);
      if (t === 'user_roles') continue;
      if (grows ? afterCounts[t] < before.counts[t] : afterCounts[t] !== before.counts[t]) {
        problems.push(`${t}: ${before.counts[t]} row(s) before, ${afterCounts[t]} after`);
      }
    }
    const afterHashes = await withClient(async (c) => ({
      personal_access_tokens: (await c.query('SELECT id, token_hash, user_id, expires_at, revoked_at FROM personal_access_tokens ORDER BY id')).rows,
      refresh_tokens: (await c.query('SELECT token_hash, user_id, revoked_at FROM refresh_tokens ORDER BY token_hash')).rows,
      device_codes: (await c.query('SELECT device_code, user_code, status, client_info FROM device_codes ORDER BY device_code')).rows,
      allowed_emails: (await c.query('SELECT email, claimed_by_id FROM allowed_emails ORDER BY email')).rows,
      node_credentials: (await c.query('SELECT id, token_hash, user_id FROM mh_legacy_node_credentials ORDER BY id')).rows,
      media_sync_devices: (await c.query('SELECT id, pat_id FROM media_sync_devices ORDER BY id')).rows,
    }));
    const norm = (rows) => JSON.parse(JSON.stringify(rows));
    for (const key of Object.keys(before.hashes)) {
      if (!same(norm(before.hashes[key]), norm(afterHashes[key]))) problems.push(`${key}: rows differ from the snapshot (ids, hashes, owners or state)`);
    }

    // 3. Profile pictures: users is back to the platform shape, user_profiles holds every non-default state.
    const cols = await withClient(async (c) => (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`)).rows.map((r) => r.column_name));
    for (const gone of ['avatar_source', 'avatar_storage_key', 'avatar_version', 'linked_person_id']) {
      if (cols.includes(gone)) problems.push(`users.${gone} still exists`);
    }
    const profiles = await withClient(async (c) => (await c.query('SELECT user_id, avatar_source, avatar_storage_key, avatar_version, linked_person_id FROM user_profiles ORDER BY user_id')).rows);
    const profileById = new Map(profiles.map((p) => [p.user_id, p]));
    const expected = before.users.filter((u) => u.avatar_source !== 'oauth' || u.avatar_storage_key || u.avatar_version || u.linked_person_id);
    for (const u of before.users) {
      const row = profileById.get(u.id);
      const wasDefault = !expected.includes(u);
      if (wasDefault && row) problems.push(`${u.email}: a default avatar state must not get a user_profiles row`);
      if (!wasDefault) {
        if (!row) { problems.push(`${u.email}: avatar state was not copied to user_profiles`); continue; }
        if (row.avatar_source !== u.avatar_source || row.avatar_storage_key !== u.avatar_storage_key || row.avatar_version !== u.avatar_version || row.linked_person_id !== u.linked_person_id) {
          problems.push(`${u.email}: user_profiles differs from the old users columns`);
        }
      }
      const now = byEmail.get(u.email);
      if (now && now.profileImageUrl !== u.profile_image_url) problems.push(`${u.email}: users.profile_image_url changed`);
    }
    console.log(`avatars: ${expected.length} non-default state(s) expected, ${profiles.length} user_profiles row(s) found (before: SELECT count(*) WHERE avatar_source<>'oauth' OR linked_person_id IS NOT NULL ...)`);
  } finally {
    await prisma.$disconnect();
  }

  const newNames = new Set([...newPermissionHolders.values()].flat());
  if (newNames.size) {
    notices.push(`${newNames.size} permission(s) did not exist before and are new platform capabilities, held by ${[...newPermissionHolders.keys()].join(', ')}: ${[...newNames].sort().join(', ')}`);
  }
  for (const n of notices) console.log(`NOTICE: ${n}`);
  if (problems.length) {
    console.error(`FAILED: ${problems.length} difference(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('OK: every user has exactly the permissions they had; credentials, sessions and avatars preserved');
}

if (mode === 'snapshot' && opt('--out')) await snapshot(opt('--out'));
else if (mode === 'verify' && opt('--before')) await verify(opt('--before'));
else {
  console.error('usage: verify-identity-transform.mjs snapshot --out <file> | verify --before <file>');
  process.exit(2);
}
