/**
 * Real-Postgres tier (RETRO-I4, #578). Proves the media_shares -> link grants cutover:
 *
 *   - on a scratch database migrated to the step BEFORE `20261109100000_i4_media_shares_to_link_grants`
 *     (circle content seeded by the RETRO-I2 fixture), five `media_shares` rows (active media, active
 *     album, expired, revoked, never expiring) and a `shares.expiring` notification stamped with an
 *     old share id;
 *   - the contract migration REFUSES to drop the table before the import;
 *   - the import (the script's logic over the platform's `importLegacyToken`, one system
 *     transaction) writes one link grant per share: `viewer`, the target type and id, the
 *     record's organization, `granted_by_id`, `created_at`, `expires_at`, `revoked_at` kept, and
 *     the token stored EXACTLY as the slice resolves it: `link_token_hash` = SHA-256 of
 *     `lnk_<old token>` (the lookup `LinkGrantsService.resolve` does for `X-Link-Token`) and a
 *     ciphertext that decrypts to `lnk_<old token>` under `sharing.link:<grant id>`, so the URL
 *     `/s/<old token>`, redirected by the SPA to `/s#lnk_<old token>`, opens the same record;
 *   - a re-run imports nothing twice; the notification stamp names the grant;
 *   - the contract migration then drops `media_shares`, `ShareTargetType` and the two retired
 *     permissions, and replays cleanly.
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

describeMaybeDb('RETRO-I4 media shares to link grants (DB_GATED: real PostgreSQL)', () => {
  const database = `i4_links_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;
  let prisma: PrismaClient;
  let savedKey: string | undefined;
  const shares: Array<{ id: string; token: string; type: 'media_item' | 'album'; resourceId: string; state: string }> = [];
  let creatorId: string;

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const runImport = () =>
    runAsSystem(prisma, 'migration-tooling', async (raw) => {
      const tx = raw as Parameters<typeof planMediaSharesImport>[0];
      const plan = await planMediaSharesImport(tx);
      return plan ? applyMediaSharesImport(tx, plan, importLegacyToken) : null;
    });

  beforeAll(async () => {
    savedKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY ??= TEST_KEY;

    admin = new Client(connection(process.env.POSTGRES_DB || 'appdb'));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client(connection(database));
    await db.connect();

    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const dir of dirs) {
      if (dir === I4) break;
      if (dir === I2) {
        await q(readFileSync(SEED, 'utf8'));
        await q(`SELECT mh_i2_seed(2, false)`);
      }
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }

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
    // A share_expiring warning sent before the cutover, keyed by the OLD share id.
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

  it('the contract migration refuses to drop media_shares before the import', async () => {
    await expect(db.query(readFileSync(join(MIGRATIONS, I4, 'migration.sql'), 'utf8'))).rejects.toThrow(/not imported as link grants yet/);
    await db.query('ROLLBACK').catch(() => undefined);
    expect((await one(`SELECT to_regclass('public.media_shares') IS NOT NULL AS present`)).present).toBe(true);
  });

  it('imports every share as a viewer link grant that resolves by its lnk_<old token>', async () => {
    const result = await runImport();

    expect(result).toMatchObject({ imported: 5, skipped: 0, invalid: 0, rekeyedNotifications: 1 });
    const defaultOrg = (await one(`SELECT id FROM organizations WHERE is_default`)).id;
    for (const share of shares) {
      const grant = await one(`SELECT * FROM grants WHERE link_token_hash = $1`, [sha256(`lnk_${share.token}`)]);
      const old = await one(`SELECT * FROM media_shares WHERE id = $1`, [share.id]);
      expect({
        kind: grant.grantee_kind,
        role: grant.role,
        type: grant.resource_type,
        resource: grant.resource_id,
        org: grant.org_id,
        grantedBy: grant.granted_by_id,
      }).toEqual({ kind: 'link', role: 'viewer', type: share.type, resource: share.resourceId, org: defaultOrg, grantedBy: creatorId });
      expect(grant.created_at).toEqual(old.created_at);
      expect(grant.expires_at).toEqual(old.expires_at);
      expect(grant.revoked_at).toEqual(old.revoked_at);
      expect(decryptSecret(grant.link_token_ciphertext, `sharing.link:${grant.id}`)).toBe(`lnk_${share.token}`);
      // The bare old token is never stored, hashed or otherwise.
      expect(await q(`SELECT 1 FROM grants WHERE link_token_hash = $1`, [sha256(share.token)])).toEqual([]);
    }
    const states = await q(
      `SELECT count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
              count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now())::int AS expired
       FROM grants WHERE grantee_kind = 'link'`,
    );
    expect(states[0]).toEqual({ revoked: 1, expired: 1 });
  });

  it('re-keys the share_expiring stamp to the grant id, so the expiry is not warned about twice', async () => {
    const grant = await one(`SELECT id FROM grants WHERE link_token_hash = $1`, [sha256(`lnk_${shares[0].token}`)]);
    const note = await one(`SELECT data FROM notifications WHERE event_key = 'shares.expiring'`);
    expect(note.data).toEqual({ shareId: grant.id, notifiedFor: '2026-01-01T00:00:00.000Z' });
  });

  it('is idempotent: a re-run imports nothing twice', async () => {
    const result = await runImport();

    expect(result).toMatchObject({ imported: 0, skipped: 5, invalid: 0 });
    expect((await one(`SELECT count(*)::int AS n FROM grants WHERE grantee_kind = 'link'`)).n).toBe(5);
  });

  it('the contract migration then drops media_shares, its enum and the retired permissions, and replays cleanly', async () => {
    const sql = readFileSync(join(MIGRATIONS, I4, 'migration.sql'), 'utf8');
    await db.query(sql);
    await db.query(sql);

    const row = await one(
      `SELECT to_regclass('public.media_shares') IS NULL AS table_gone,
              NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShareTargetType') AS enum_gone,
              NOT EXISTS (SELECT 1 FROM permissions WHERE name IN ('shares:manage', 'shares:manage_any')) AS permissions_gone`,
    );
    expect(row).toEqual({ table_gone: true, enum_gone: true, permissions_gone: true });
    expect((await one(`SELECT count(*)::int AS n FROM grants WHERE grantee_kind = 'link'`)).n).toBe(5);
    // With the table gone the import is a no-op, not an error.
    expect(await runImport()).toBeNull();
  });
});
