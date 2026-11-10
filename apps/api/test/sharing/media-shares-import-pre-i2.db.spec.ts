/**
 * Real-Postgres tier (RETRO-I4 follow-up, #578 / #592). Proves the media_shares import works on a
 * database at the PRE-I2 state (what production is on before the combined `prisma:migrate`) and that
 * the rest of the migration train then passes:
 *
 *   - scratch database migrated to the step BEFORE `20261108200000_i2_circles_to_groups_ownership`
 *     (no org_id on media_items / albums), circle content seeded, five `media_shares` rows (media
 *     item and album targets; active, expired, revoked, never expiring) and a `shares.expiring`
 *     notification stamped with an old share id;
 *   - the import (--apply logic) runs there and writes one link grant per share;
 *   - after I2 the imported grants are deleted and re-imported through the post-I2 path (org from
 *     `media_items.org_id`): the normalized rows are IDENTICAL to the pre-I2 import;
 *   - every remaining migration (I4 .. latest) then passes: the I4 guard finds every share
 *     imported, `media_shares` is dropped;
 *   - each grant resolves as the sharing slice resolves a link: SHA-256 of `lnk_<old token>` and a
 *     ciphertext that decrypts to `lnk_<old token>`; revoked/expired timestamps and creator kept.
 *
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { decryptSecret, runAsSystem } from '@marinoscar/platform-api/core';
import { importLegacyToken } from '@marinoscar/platform-api/sharing';
import { Client } from 'pg';

import '../../src/app-registrations/sharing';
import { applyMediaSharesImport, planMediaSharesImport } from '../../src/legacy/media-shares-import';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const I2 = '20261108200000_i2_circles_to_groups_ownership';
const I4 = '20261109100000_i4_media_shares_to_link_grants';
const SEED = join(__dirname, 'fixtures', 'circle-content.seed.sql');
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

type Row = Record<string, any>;

function connection(database: string) {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database,
  };
}

function url(database: string): string {
  const c = connection(database);
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${database}`;
}

/** Applies one migration file the way `prisma migrate deploy` would (see ownership.db.spec.ts). */
async function applyMigration(client: Client, sql: string): Promise<void> {
  if (sql.includes('$$') || /^\s*BEGIN\s*;/im.test(sql)) {
    await client.query(sql);
    return;
  }
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) await client.query(statement);
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const oldToken = (): string => randomBytes(32).toString('base64url');

describeMaybeDb('media shares import before the I2 ownership migration (DB_GATED: real PostgreSQL)', () => {
  const database = `i4_pre_i2_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;
  let prisma: PrismaClient;
  let savedKey: string | undefined;
  let dirs: string[];
  const shares: Array<{ id: string; token: string; type: 'media_item' | 'album'; resourceId: string; state: string }> = [];
  let creatorId: string;
  let defaultOrg: string;

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const withTx = <T>(fn: (tx: Parameters<typeof planMediaSharesImport>[0]) => Promise<T>) =>
    runAsSystem(prisma, 'migration-tooling', async (raw) => fn(raw as Parameters<typeof planMediaSharesImport>[0]));
  const runImport = () =>
    withTx(async (tx) => {
      const plan = await planMediaSharesImport(tx);
      return plan ? applyMediaSharesImport(tx, plan, importLegacyToken) : null;
    });

  /** The grants, normalized (grant ids and ciphertext differ per import, everything else must not). */
  const linkGrants = async () =>
    q(
      `SELECT link_token_hash, role, resource_type, resource_id, org_id, granted_by_id, created_at, expires_at, revoked_at
       FROM grants WHERE grantee_kind = 'link' ORDER BY link_token_hash`,
    );

  beforeAll(async () => {
    savedKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY ??= TEST_KEY;

    admin = new Client(connection(process.env.POSTGRES_DB || 'appdb'));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client(connection(database));
    await db.connect();

    dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const dir of dirs) {
      if (dir === I2) {
        await q(readFileSync(SEED, 'utf8'));
        await q(`SELECT mh_i2_seed(2, false)`);
        break;
      }
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }
    defaultOrg = (await one(`SELECT id FROM organizations WHERE is_default`)).id;

    const album = await one(`SELECT a.id, a.circle_id, a.added_by_id FROM albums a JOIN circles c ON c.id = a.circle_id WHERE c.name = 'Circle Alpha'`);
    const items = await q(`SELECT id FROM media_items WHERE circle_id = $1 ORDER BY id`, [album.circle_id]);
    creatorId = album.added_by_id;
    const plan: Array<{ type: 'media_item' | 'album'; resourceId: string; state: string; expires: string | null; revoked: string | null }> = [
      { type: 'media_item', resourceId: items[0].id, state: 'active', expires: `now() + interval '3 days'`, revoked: null },
      { type: 'album', resourceId: album.id, state: 'active', expires: null, revoked: null },
      { type: 'media_item', resourceId: items[1].id, state: 'expired', expires: `now() - interval '1 day'`, revoked: null },
      { type: 'album', resourceId: album.id, state: 'revoked', expires: null, revoked: `now() - interval '2 days'` },
      { type: 'media_item', resourceId: items[0].id, state: 'never', expires: null, revoked: null },
    ];
    for (const s of plan) {
      const id = randomUUID();
      const token = oldToken();
      await q(
        `INSERT INTO media_shares (id, token, target_type, media_item_id, album_id, circle_id, created_by_id, expires_at, revoked_at, created_at)
         VALUES ($1, $2, $3::"ShareTargetType", $4, $5, $6, $7, ${s.expires ?? 'NULL'}, ${s.revoked ?? 'NULL'}, now() - interval '30 days')`,
        [id, token, s.type, s.type === 'media_item' ? s.resourceId : null, s.type === 'album' ? s.resourceId : null, album.circle_id, creatorId],
      );
      shares.push({ id, token, type: s.type, resourceId: s.resourceId, state: s.state });
    }
    await q(
      `INSERT INTO notifications (id, user_id, event_key, title, body, data, updated_at)
       VALUES (gen_random_uuid(), $1, 'shares.expiring', 'A public share expires soon', '', $2::jsonb, now())`,
      [creatorId, JSON.stringify({ shareId: shares[0].id, notifiedFor: '2026-01-01T00:00:00.000Z' })],
    );

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url(database), max: 2 }) });
  }, 300_000);

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
    await prisma?.$disconnect();
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  let beforeI2: Row[];

  it('the fixture is at the pre-I2 state: no org_id on media_items or albums', async () => {
    const cols = await q(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'org_id' AND table_name IN ('media_items', 'albums')`,
    );
    expect(cols).toEqual([]);
  });

  it('imports every share as a viewer link grant BEFORE I2, in the default organization', async () => {
    const plan = await withTx((tx) => planMediaSharesImport(tx));
    expect(plan!.toImport.map((r) => r.orgId)).toEqual(Array(5).fill(defaultOrg));

    const result = await runImport();
    expect(result).toMatchObject({ imported: 5, skipped: 0, invalid: 0, rekeyedNotifications: 1 });

    beforeI2 = await linkGrants();
    expect(beforeI2).toHaveLength(5);
    for (const share of shares) {
      const grant = await one(`SELECT * FROM grants WHERE link_token_hash = $1`, [sha256(`lnk_${share.token}`)]);
      const old = await one(`SELECT * FROM media_shares WHERE id = $1`, [share.id]);
      expect({ kind: grant.grantee_kind, role: grant.role, type: grant.resource_type, resource: grant.resource_id, org: grant.org_id, grantedBy: grant.granted_by_id }).toEqual({
        kind: 'link',
        role: 'viewer',
        type: share.type,
        resource: share.resourceId,
        org: defaultOrg,
        grantedBy: creatorId,
      });
      expect(grant.created_at).toEqual(old.created_at);
      expect(grant.expires_at).toEqual(old.expires_at);
      expect(grant.revoked_at).toEqual(old.revoked_at);
      expect(decryptSecret(grant.link_token_ciphertext, `sharing.link:${grant.id}`)).toBe(`lnk_${share.token}`);
    }
    // Idempotent: a re-run before I2 imports nothing twice.
    expect(await runImport()).toMatchObject({ imported: 0, skipped: 5, invalid: 0 });
    // The expiry stamp names the grant.
    const grant0 = await one(`SELECT id FROM grants WHERE link_token_hash = $1`, [sha256(`lnk_${shares[0].token}`)]);
    expect((await one(`SELECT data FROM notifications WHERE event_key = 'shares.expiring'`)).data).toEqual({
      shareId: grant0.id,
      notifiedFor: '2026-01-01T00:00:00.000Z',
    });
  });

  it('after I2 the import derives the same grants from media_items.org_id (delete them, re-import, compare)', async () => {
    const i2 = dirs.indexOf(I2);
    const i4 = dirs.indexOf(I4);
    for (const dir of dirs.slice(i2, i4)) {
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }
    expect((await one(`SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name = 'org_id' AND table_name IN ('media_items', 'albums')`)).n).toBe(2);

    await q(`DELETE FROM grants WHERE grantee_kind = 'link'`);
    expect(await runImport()).toMatchObject({ imported: 5, skipped: 0, invalid: 0 });
    expect(await linkGrants()).toEqual(beforeI2);
  }, 300_000);

  it('every remaining migration (I4 .. latest) then passes: the I4 guard finds all shares imported', async () => {
    for (const dir of dirs.slice(dirs.indexOf(I4))) {
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }
    expect((await one(`SELECT to_regclass('public.media_shares') IS NULL AS gone`)).gone).toBe(true);
    expect((await one(`SELECT count(*)::int AS n FROM grants WHERE grantee_kind = 'link'`)).n).toBe(5);
    expect(await runImport()).toBeNull();
  }, 300_000);

  it('the grants resolve like the slice resolves a link, and survive the migrations unchanged', async () => {
    expect(await linkGrants()).toEqual(beforeI2);
    for (const share of shares) {
      const grant = await one(`SELECT * FROM grants WHERE grantee_kind = 'link' AND link_token_hash = $1`, [sha256(`lnk_${share.token}`)]);
      expect(grant).toBeDefined();
      expect(decryptSecret(grant.link_token_ciphertext, `sharing.link:${grant.id}`)).toBe(`lnk_${share.token}`);
      expect(grant.resource_id).toBe(share.resourceId);
    }
  });
});
