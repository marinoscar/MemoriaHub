/**
 * Real-Postgres tier (RETRO-K2, #588): `20261110100000_k2_drop_circles` on a seeded database.
 *
 * A scratch database is migrated to the step before RETRO-I2 and seeded with circle content of every
 * kind (test/sharing/fixtures/circle-content.seed.sql: shared and personal circles, members, and rows
 * in all 21 content tables), then migrated to the step before K2. The proof is a comparison, taken
 * before and after the migration, of EVERY content table: row count and a hash of
 * (id, circle_id, org_id, owner_group_id, owner_user_id). Nothing may change. On top:
 *
 *   - the circle tables, the enum, the mirror triggers and their functions are gone, and
 *     `personal_libraries` holds exactly the personal circles, with the same ids;
 *   - the owner of a new or moved content row still follows its `circle_id` (a group id: group-owned,
 *     a personal library id: user-owned) and an id naming neither is refused with 23503;
 *   - a library created as a group alone (what `POST /api/groups` does) takes content at once, and an
 *     EMPTY group can be deleted (it used to be refused while its circle existed);
 *   - the migration replays cleanly.
 *
 * Needs a reachable PostgreSQL superuser (the scratch database is created and dropped). Skips
 * (reported as skipped) when nothing listens on the configured port.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { createPersonalLibrary, createSharedLibrary } from '../helpers/library';
import { orgScoped } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const I2 = '20261108200000_i2_circles_to_groups_ownership';
const K2 = '20261110100000_k2_drop_circles';
const SEED = join(__dirname, '..', 'sharing', 'fixtures', 'circle-content.seed.sql');

const CONTENT_TABLES = [
  'media_items', 'albums', 'tags', 'people', 'faces', 'memories', 'media_item_embedding', 'media_geocode_status',
  'media_metadata_status', 'media_tag_status', 'media_transcripts', 'burst_groups', 'duplicate_groups',
  'location_suggestions', 'media_enhancements', 'media_enhancement_batches', 'review_runs', 'trash_empty_runs',
  'workflows', 'workflow_runs', 'media_visual_embedding',
];
const KEYLESS = ['media_item_embedding', 'media_visual_embedding']; // keyed by media_item_id

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

describeMaybeDb('RETRO-K2 drops circles without touching content (DB_GATED: real PostgreSQL)', () => {
  const database = `k2_drop_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;
  let k2Sql: string;
  let before: Record<string, { n: number; h: string }>;
  let personalBefore: Row[];

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await orgScoped(db, { bypass: true }).query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const fingerprint = async (): Promise<Record<string, { n: number; h: string }>> => {
    const out: Record<string, { n: number; h: string }> = {};
    for (const table of CONTENT_TABLES) {
      const key = KEYLESS.includes(table) ? 'media_item_id' : 'id';
      const row = await one(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(concat_ws('|', ${key}, circle_id, org_id, owner_group_id, owner_user_id), ',' ORDER BY ${key})), '') AS h FROM ${table}`,
      );
      out[table] = { n: row.n, h: row.h };
    }
    return out;
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
      if (dir === K2) break;
      if (dir === I2) {
        await q(readFileSync(SEED, 'utf8'));
        await q(`SELECT mh_i2_seed(3, false)`);
      }
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }

    before = await fingerprint();
    personalBefore = await q(`SELECT id::text AS id, owner_id::text AS owner FROM circles WHERE is_personal ORDER BY id`);
    k2Sql = readFileSync(join(MIGRATIONS, K2, 'migration.sql'), 'utf8');
    await db.query(k2Sql);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('the seed is real: every content table had rows, shared and personal', async () => {
    for (const table of CONTENT_TABLES) expect(before[table]!.n).toBeGreaterThan(0);
    expect(personalBefore.length).toBeGreaterThan(0);
    expect((await one(`SELECT count(*)::int AS n FROM groups`)).n).toBeGreaterThan(0);
  });

  it.each(CONTENT_TABLES)('%s: row count, circle_id, org and owner columns are unchanged', async (table) => {
    const after = await fingerprint();
    expect(after[table]).toEqual(before[table]);
  });

  it('the circle tables, the enum, the mirror triggers and the old functions are gone', async () => {
    expect((await one(`SELECT to_regclass('public.circles') IS NULL AS gone`)).gone).toBe(true);
    expect((await one(`SELECT to_regclass('public.circle_members') IS NULL AS gone`)).gone).toBe(true);
    expect((await one(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'CircleRole'`)).n).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('mh_owner_from_circle', 'mh_group_mirror_guard', 'mh_circle_mirror_group', 'mh_circle_member_mirror')`)).n).toBe(0);
    expect(
      (await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('mh_circle_mirror_group', 'mh_circle_member_mirror', 'mh_group_mirror_guard', 'mh_content_owner_from_circle', 'mh_circle_role_to_group_role')`)).n,
    ).toBe(0);
    expect((await one(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'mh_owner_from_scope'`)).n).toBe(CONTENT_TABLES.length);
    // No foreign key of any table names a circle table any more.
    expect(
      (await one(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND pg_get_constraintdef(oid) ILIKE '%REFERENCES circles%'`)).n,
    ).toBe(0);
  });

  it('personal_libraries holds exactly the personal circles, with the same ids', async () => {
    const libraries = await q(`SELECT id::text AS id, user_id::text AS owner FROM personal_libraries ORDER BY id`);
    expect(libraries).toEqual(personalBefore);
  });

  it('a new content row takes its owner from circle_id: group id -> group-owned, personal id -> user-owned', async () => {
    const group = await one(`SELECT id::text AS id FROM groups LIMIT 1`);
    const library = personalBefore[0]!;
    const insert = async (circleId: string) =>
      one(
        `INSERT INTO tags (added_by_id, name, circle_id) VALUES ($1, $2, $3) RETURNING id::text AS id, org_id::text AS org, owner_group_id::text AS g, owner_user_id::text AS u`,
        [library.owner, `K2 tag ${randomUUID()}`, circleId],
      );
    expect(await insert(group.id)).toMatchObject({ g: group.id, u: null });
    const mine = await insert(library.id);
    expect(mine).toMatchObject({ g: null, u: library.owner });
    expect(mine.org).toBeTruthy();

    // A move re-owns the row.
    await q(`UPDATE tags SET circle_id = $2 WHERE id = $1`, [mine.id, group.id]);
    expect(await one(`SELECT owner_group_id::text AS g, owner_user_id::text AS u FROM tags WHERE id = $1`, [mine.id])).toEqual({ g: group.id, u: null });
  });

  it('refuses a scope that is neither a group nor a personal library (what the foreign key did)', async () => {
    const library = personalBefore[0]!;
    await expect(
      q(`INSERT INTO tags (added_by_id, name, circle_id) VALUES ($1, 'orphan', $2)`, [library.owner, randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a library made as a group alone takes content at once, and an empty group can be deleted', async () => {
    const owner = personalBefore[0]!.owner;
    const id = randomUUID();
    await createSharedLibrary(db, { id, createdById: owner });
    const tag = await one(`INSERT INTO tags (added_by_id, name, circle_id) VALUES ($1, 'fresh', $2) RETURNING owner_group_id::text AS g`, [owner, id]);
    expect(tag.g).toBe(id);
    // With content the delete is refused by the owner key (the application answers 409 first) ...
    await expect(q(`DELETE FROM groups WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23503' });
    // ... and once it is empty the group goes, with nothing circle-shaped to stop it.
    await q(`DELETE FROM tags WHERE circle_id = $1`, [id]);
    await q(`DELETE FROM group_members WHERE group_id = $1`, [id]);
    await q(`DELETE FROM groups WHERE id = $1`, [id]);
    expect((await one(`SELECT count(*)::int AS n FROM groups WHERE id = $1`, [id])).n).toBe(0);
  });

  it('a new personal library takes content (sign-up) and is the only row a user has', async () => {
    const userId = randomUUID();
    const libraryId = randomUUID();
    await q(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [userId, `k2-${libraryId}@example.test`]);
    await createPersonalLibrary(db, { id: libraryId, userId });
    await expect(createPersonalLibrary(db, { id: randomUUID(), userId })).rejects.toMatchObject({ code: '23505' });
    const row = await one(`INSERT INTO tags (added_by_id, name, circle_id) VALUES ($1, 'mine', $2) RETURNING owner_user_id::text AS u`, [userId, libraryId]);
    expect(row.u).toBe(userId);
    await q(`DELETE FROM tags WHERE circle_id = $1`, [libraryId]);
  });

  it('replays cleanly and changes nothing', async () => {
    const snapshot = await fingerprint();
    await db.query(k2Sql);
    expect(await fingerprint()).toEqual(snapshot);
  });
});
