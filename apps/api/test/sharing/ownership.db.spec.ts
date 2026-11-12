/**
 * Real-Postgres tier (RETRO-I2, #569). Proves `20261108200000_i2_circles_to_groups_ownership`:
 *
 *   - the BACKFILL, on a scratch database migrated to the step BEFORE it and seeded with circle
 *     content of every kind (test/sharing/fixtures/circle-content.seed.sql): one group per shared
 *     circle with the same id, mapped member roles, a circle owner made admin of a group that had
 *     none, and on all 21 content tables an owner equal to what circle_id says, org_id set;
 *   - the file is RE-RUNNABLE: replaying it changes nothing;
 *   - the CONSTRAINTS: exactly one owner (CHECK), the composite key refuses a group of another
 *     organization, a group that owns rows cannot be deleted, the media dedup still holds per
 *     circle (= per owner) and not across;
 *   - ROW-LEVEL SECURITY: a NOSUPERUSER NOBYPASSRLS role sees a content row only under its
 *     organization's `app.org_id`;
 *   - the SHIM TRIGGERS (PLATFORM-ADOPTION-SHIM(#573)): a new circle and its members appear as a
 *     group and members, a content insert takes its owner from circle_id, a move re-owns the row,
 *     deleting the circle deletes the group, and a mirrored group cannot be deleted on its own;
 *   - the REGISTRATIONS (`app-registrations/sharing.ts`) read the new columns: `loadOwners` of
 *     `media_item` / `album` (a trashed item is missing) and every group-owned `countOwnedByGroup`.
 *
 * The scratch database is created and dropped by the spec (needs CREATEDB; the db tier runs as the
 * bootstrap superuser). Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import {
  ALBUM_RESOURCE_TYPE,
  MEDIA_ITEM_RESOURCE_TYPE,
  MEMORIAHUB_GROUP_OWNED_RESOURCES,
} from '../../src/app-registrations/sharing';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { orgScoped } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const I2 = '20261108200000_i2_circles_to_groups_ownership';
const SEED = join(__dirname, 'fixtures', 'circle-content.seed.sql');

const CONTENT_TABLES = [
  'media_items', 'albums', 'tags', 'people', 'faces', 'memories', 'media_item_embedding', 'media_geocode_status',
  'media_metadata_status', 'media_tag_status', 'media_transcripts', 'burst_groups', 'duplicate_groups',
  'location_suggestions', 'media_enhancements', 'media_enhancement_batches', 'review_runs', 'trash_empty_runs',
  'workflows', 'workflow_runs', 'media_visual_embedding',
];

type Row = Record<string, any>;

function connection(database: string): { host: string; port: number; user: string; password: string; database: string } {
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

/**
 * Applies one migration file the way `prisma migrate deploy` would. A file with a dollar-quoted
 * body or an explicit transaction runs as one script; any other is split into statements, so
 * `ALTER TYPE ... ADD VALUE` and `CREATE INDEX CONCURRENTLY` run outside a transaction block.
 */
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

describeMaybeDb('RETRO-I2 circles to groups and content ownership (DB_GATED: real PostgreSQL)', () => {
  const database = `i2_ownership_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const role = `i2_app_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let admin: Client;
  let db: Client;
  let prisma: PrismaClient;
  let migration: string;
  let defaultOrg: string;

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await orgScoped(db, { bypass: true }).query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const circleByName = async (name: string): Promise<Row> => one(`SELECT * FROM circles WHERE name = $1`, [name]);

  /** Every content row's owner, as a stable fingerprint. */
  const ownershipFingerprint = async (): Promise<string> => {
    const parts: string[] = [];
    for (const table of CONTENT_TABLES) {
      const key = ['media_item_embedding', 'media_visual_embedding'].includes(table) ? 'media_item_id' : 'id';
      const row = await one(
        `SELECT count(*)::int AS n, md5(string_agg(${key}::text || ':' || org_id || ':' || coalesce(owner_group_id::text, '') || ':' ||
                coalesce(owner_user_id::text, ''), ',' ORDER BY ${key})) AS h FROM ${table}`,
      );
      parts.push(`${table}=${row.n}/${row.h}`);
    }
    const groups = await one(`SELECT md5(string_agg(id::text || name || coalesce(description, '') || org_id, ',' ORDER BY id)) AS h FROM groups`);
    const members = await one(
      `SELECT md5(string_agg(group_id::text || user_id::text || role, ',' ORDER BY group_id, user_id)) AS h FROM group_members`,
    );
    return [...parts, `groups=${groups.h}`, `members=${members.h}`].join('\n');
  };

  beforeAll(async () => {
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
      if (dir === I2) break;
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }
    defaultOrg = (await one(`SELECT id FROM organizations WHERE is_default`)).id;

    await q(readFileSync(SEED, 'utf8'));
    await q(`SELECT mh_i2_seed(3, false)`);

    migration = readFileSync(join(MIGRATIONS, I2, 'migration.sql'), 'utf8');
    await db.query(migration);

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url(database), max: 2 }) });
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  describe('the backfill', () => {
    it('creates one group per shared circle with the same id, and none for a personal circle', async () => {
      const rows = await q(
        `SELECT c.name, c.is_personal, g.id IS NOT NULL AS has_group, g.org_id, g.created_by_id = c.owner_id AS creator
         FROM circles c LEFT JOIN groups g ON g.id = c.id ORDER BY c.name`,
      );
      const shared = rows.filter((r) => !r.is_personal);
      expect(shared.map((r) => r.name)).toEqual(['Circle Alpha', 'Circle Beta', 'Circle Gamma']);
      expect(shared.every((r) => r.has_group && r.org_id === defaultOrg && r.creator)).toBe(true);
      expect(rows.filter((r) => r.is_personal && r.has_group)).toEqual([]);
      expect((await one(`SELECT count(*)::int AS n FROM groups`)).n).toBe(3);
    });

    it('maps member roles, and makes the circle owner admin of a group that had none', async () => {
      const members = await q(
        `SELECT g.name, u.email, gm.role FROM group_members gm JOIN groups g ON g.id = gm.group_id JOIN users u ON u.id = gm.user_id
         ORDER BY g.name, u.email`,
      );
      const short = members.map((m) => `${m.name}|${(m.email as string).slice(0, 8)}|${m.role}`);
      expect(short).toEqual([
        'Circle Alpha|person-a|admin',
        'Circle Alpha|person-b|editor',
        'Circle Alpha|person-c|viewer',
        // B was the only member, a collaborator: promoted (the owner).
        'Circle Beta|person-b|admin',
        // D owns the circle but was not a member: added as admin.
        'Circle Gamma|person-c|viewer',
        'Circle Gamma|person-d|admin',
      ]);
    });

    it.each(CONTENT_TABLES)('gives every %s row the owner its circle_id names', async (table) => {
      const row = await one(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE t.org_id IS DISTINCT FROM $1)::int AS bad_org,
                count(*) FILTER (WHERE num_nonnulls(t.owner_user_id, t.owner_group_id) <> 1)::int AS not_one,
                count(*) FILTER (WHERE NOT ((c.is_personal AND t.owner_user_id = c.owner_id AND t.owner_group_id IS NULL)
                                        OR (NOT c.is_personal AND t.owner_group_id = c.id AND t.owner_user_id IS NULL)))::int AS wrong,
                count(*) FILTER (WHERE t.owner_group_id IS NOT NULL)::int AS grp
         FROM ${table} t JOIN circles c ON c.id = t.circle_id`,
        [defaultOrg],
      );
      expect(row.n).toBeGreaterThan(0);
      expect(row.grp).toBeGreaterThan(0);
      expect(row.grp).toBeLessThan(row.n);
      expect({ badOrg: row.bad_org, notOne: row.not_one, wrong: row.wrong }).toEqual({ badOrg: 0, notOne: 0, wrong: 0 });
    });

    it('rebuilds the HNSW indexes it dropped for the backfill exactly as platform.lock lists them', async () => {
      const lock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'prisma', 'platform.lock'), 'utf8')) as {
        rawSqlIndexes: { name: string; definition: string }[];
      };
      const hnsw = lock.rawSqlIndexes.filter((index) => /USING hnsw/.test(index.definition));
      expect(hnsw.map((index) => index.name).sort()).toEqual([
        'faces_embedding_vec_archive_hnsw_idx',
        'faces_embedding_vec_assigned_hnsw_idx',
        'faces_embedding_vec_hnsw_idx',
        'media_item_embedding_hnsw_idx',
        'media_visual_embedding_hnsw_idx',
      ]);
      for (const index of hnsw) {
        const row = await one(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [index.name]);
        expect([index.name, row?.indexdef]).toEqual([index.name, index.definition]);
      }
    });

    it('leaves circles, circle members and every circle_id untouched', async () => {
      expect((await one(`SELECT count(*)::int AS n FROM circles`)).n).toBe(7);
      expect((await one(`SELECT count(*)::int AS n FROM circle_members`)).n).toBe(9);
      expect((await one(`SELECT count(*)::int AS n FROM media_items WHERE circle_id IS NULL`)).n).toBe(0);
    });

    it('is re-runnable: replaying the migration changes nothing', async () => {
      const before = await ownershipFingerprint();
      await db.query(migration);
      expect(await ownershipFingerprint()).toBe(before);
    });
  });

  describe('the constraints', () => {
    it('refuses a row with both owners or with none', async () => {
      const alpha = await circleByName('Circle Alpha');
      const tag = await one(`SELECT id FROM tags WHERE circle_id = $1 LIMIT 1`, [alpha.id]);
      await expect(q(`UPDATE tags SET owner_user_id = $2 WHERE id = $1`, [tag.id, alpha.owner_id])).rejects.toThrow(/tags_one_owner_check/);
      await expect(q(`UPDATE tags SET owner_group_id = NULL WHERE id = $1`, [tag.id])).rejects.toThrow(/tags_one_owner_check/);
    });

    it('refuses an owning group of another organization (composite key)', async () => {
      const otherOrg = randomUUID();
      const otherGroup = randomUUID();
      await q(`INSERT INTO organizations (id, name, slug, is_default, updated_at) VALUES ($1, 'Org Beta', $2, false, now())`, [
        otherOrg,
        `org-beta-${otherOrg.slice(0, 8)}`,
      ]);
      await q(`BEGIN`);
      await q(`SELECT set_config('app.rls_bypass', 'on', true)`);
      await q(`INSERT INTO groups (id, org_id, name, updated_at) VALUES ($1, $2, 'Group of Org Beta', now())`, [otherGroup, otherOrg]);
      await q(`COMMIT`);
      const alpha = await circleByName('Circle Alpha');
      const album = await one(`SELECT id FROM albums WHERE circle_id = $1`, [alpha.id]);
      await expect(q(`UPDATE albums SET owner_group_id = $2 WHERE id = $1`, [album.id, otherGroup])).rejects.toThrow(
        /albums_owner_group_id_org_id_fkey/,
      );
    });

    it('refuses deleting a group that owns rows', async () => {
      const alpha = await circleByName('Circle Alpha');
      // The guard trigger would refuse first (the circle exists); disable it to reach the key.
      await q(`BEGIN`);
      await q(`ALTER TABLE groups DISABLE TRIGGER mh_group_mirror_guard`);
      await expect(q(`DELETE FROM groups WHERE id = $1`, [alpha.id])).rejects.toThrow(/owner_group_id_org_id_fkey/);
      await q(`ROLLBACK`);
    });

    it('keeps the media dedup per circle (= per owner), not across', async () => {
      const alpha = await circleByName('Circle Alpha');
      const beta = await circleByName('Circle Beta');
      const item = await one(`SELECT * FROM media_items WHERE circle_id = $1 LIMIT 1`, [alpha.id]);
      const insert = async (circleId: string) => {
        const object = randomUUID();
        await q(
          `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id, status)
           VALUES ($1, 'copy.jpg', 1000, 'image/jpeg', $2, now(), $3, 'ready')`,
          [object, `seed/copy/${object}`, defaultOrg],
        );
        return q(
          `INSERT INTO media_items (storage_object_id, added_by_id, updated_at, type, source, original_filename, circle_id, content_hash)
           VALUES ($1, $2, now(), 'photo', 'web', 'copy.jpg', $3, $4)`,
          [object, item.added_by_id, circleId, item.content_hash],
        );
      };
      await expect(insert(alpha.id)).rejects.toThrow(/media_items_circle_content_hash_active_key/);
      await insert(beta.id);
      const copy = await one(`SELECT owner_group_id FROM media_items WHERE circle_id = $1 AND content_hash = $2`, [beta.id, item.content_hash]);
      expect(copy.owner_group_id).toBe(beta.id);
    });
  });

  describe('row-level security', () => {
    it('shows a content row to an ordinary role only under its organization', async () => {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'i2-test' NOSUPERUSER NOBYPASSRLS`);
      await q(`GRANT SELECT ON media_items, albums TO ${role}`);
      const c = new Client({ ...connection(database), user: role, password: 'i2-test' });
      await c.connect();
      try {
        const count = async (orgId: string | null): Promise<number> => {
          await c.query('BEGIN');
          if (orgId) await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
          const n = (await c.query(`SELECT count(*)::int AS n FROM media_items`)).rows[0].n as number;
          await c.query('ROLLBACK');
          return n;
        };
        const total = (await one(`SELECT count(*)::int AS n FROM media_items`)).n;
        expect(await count(null)).toBe(0);
        expect(await count(randomUUID())).toBe(0);
        expect(await count(defaultOrg)).toBe(total);
      } finally {
        await c.end();
      }
    });
  });

  describe('the shim triggers (PLATFORM-ADOPTION-SHIM(#573))', () => {
    it('mirrors a new circle and its members, owns its content, re-owns a moved row and deletes the group with the circle', async () => {
      const a = await one(`SELECT id FROM users WHERE email LIKE 'person-a-%'`);
      const personal = await one(`SELECT id FROM circles WHERE owner_id = $1 AND is_personal`, [a.id]);
      const delta = randomUUID();
      await q(`INSERT INTO circles (id, name, owner_id, is_personal, updated_at) VALUES ($1, 'Circle Delta', $2, false, now())`, [delta, a.id]);
      await q(`INSERT INTO circle_members (circle_id, user_id, role, updated_at) VALUES ($1, $2, 'collaborator', now())`, [delta, a.id]);
      expect(await one(`SELECT g.name, gm.role FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE g.id = $1`, [delta])).toEqual({
        name: 'Circle Delta',
        role: 'editor',
      });

      await q(`UPDATE circle_members SET role = 'circle_admin' WHERE circle_id = $1`, [delta]);
      await q(`UPDATE circles SET name = 'Circle Delta 2' WHERE id = $1`, [delta]);
      expect(await one(`SELECT g.name, g.version, gm.role FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE g.id = $1`, [delta])).toEqual({
        name: 'Circle Delta 2',
        version: 2,
        role: 'admin',
      });

      const tag = await one(
        `INSERT INTO tags (added_by_id, name, circle_id) VALUES ($1, 'Delta tag', $2) RETURNING id, org_id, owner_group_id, owner_user_id`,
        [a.id, delta],
      );
      expect(tag).toMatchObject({ org_id: defaultOrg, owner_group_id: delta, owner_user_id: null });

      await expect(q(`DELETE FROM groups WHERE id = $1`, [delta])).rejects.toThrow(/mirrors a circle/);

      await q(`UPDATE tags SET circle_id = $2 WHERE id = $1`, [tag.id, personal.id]);
      expect(await one(`SELECT owner_group_id, owner_user_id FROM tags WHERE id = $1`, [tag.id])).toEqual({
        owner_group_id: null,
        owner_user_id: a.id,
      });

      await q(`DELETE FROM circle_members WHERE circle_id = $1`, [delta]);
      expect((await one(`SELECT count(*)::int AS n FROM group_members WHERE group_id = $1`, [delta])).n).toBe(0);
      await q(`DELETE FROM circles WHERE id = $1`, [delta]);
      expect((await one(`SELECT count(*)::int AS n FROM groups WHERE id = $1`, [delta])).n).toBe(0);
    });

    it('restores the caller\'s RLS bypass after mirroring', async () => {
      const a = await one(`SELECT id FROM users WHERE email LIKE 'person-a-%'`);
      await q('BEGIN');
      await q(`INSERT INTO circles (name, owner_id, is_personal, updated_at) VALUES ('Circle Epsilon', $1, false, now())`, [a.id]);
      const setting = await one(`SELECT coalesce(current_setting('app.rls_bypass', true), '') AS v`);
      await q('ROLLBACK');
      expect(setting.v).not.toBe('on');
    });

    it('refuses changing a circle\'s kind', async () => {
      const alpha = await circleByName('Circle Alpha');
      await expect(q(`UPDATE circles SET is_personal = true WHERE id = $1`, [alpha.id])).rejects.toThrow(/cannot change is_personal/);
    });
  });

  describe('the registrations read the new columns', () => {
    it('loadOwners of media_item and album (a trashed item is missing)', async () => {
      const alpha = await circleByName('Circle Alpha');
      const a = await one(`SELECT id FROM users WHERE email LIKE 'person-a-%'`);
      const personal = await one(`SELECT id FROM circles WHERE owner_id = $1 AND is_personal`, [a.id]);
      const shared = await one(`SELECT id FROM media_items WHERE circle_id = $1 LIMIT 1`, [alpha.id]);
      const mine = await q(`SELECT id FROM media_items WHERE circle_id = $1 ORDER BY id LIMIT 2`, [personal.id]);
      await q(`UPDATE media_items SET deleted_at = now() WHERE id = $1`, [mine[1].id]);

      const owners = await prisma.$transaction((tx) => MEDIA_ITEM_RESOURCE_TYPE.loadOwners([shared.id, mine[0].id, mine[1].id], tx));
      expect(owners.get(shared.id)).toEqual({ orgId: defaultOrg, owner: { kind: 'group', groupId: alpha.id } });
      expect(owners.get(mine[0].id)).toEqual({ orgId: defaultOrg, owner: { kind: 'user', userId: a.id } });
      expect(owners.has(mine[1].id)).toBe(false);

      const album = await one(`SELECT id FROM albums WHERE circle_id = $1`, [alpha.id]);
      const albumOwners = await prisma.$transaction((tx) => ALBUM_RESOURCE_TYPE.loadOwners([album.id], tx));
      expect(albumOwners.get(album.id)).toEqual({ orgId: defaultOrg, owner: { kind: 'group', groupId: alpha.id } });
    });

    it('every group-owned type counts the group\'s rows', async () => {
      const gamma = await circleByName('Circle Gamma');
      const counts: Record<string, number> = {};
      await prisma.$transaction(async (tx) => {
        for (const entry of MEMORIAHUB_GROUP_OWNED_RESOURCES) counts[entry.type] = await entry.count(tx, gamma.id);
        counts.media_item = await MEDIA_ITEM_RESOURCE_TYPE.countOwnedByGroup!(gamma.id, tx);
        counts.album = await ALBUM_RESOURCE_TYPE.countOwnedByGroup!(gamma.id, tx);
      });
      for (const [type, n] of Object.entries(counts)) expect([type, n > 0]).toEqual([type, true]);
      const none = await prisma.$transaction((tx) => MEDIA_ITEM_RESOURCE_TYPE.countOwnedByGroup!(randomUUID(), tx));
      expect(none).toBe(0);
    });
  });
});
