/**
 * Real-Postgres tier (RETRO-A5b, #653). Proves that
 * `20261108160000_rename_legacy_storage_migration_tables` is a pure rename: the legacy
 * storage-migration rows survive with every value, enum label, key and cascade intact, and the
 * renamed tables are what the app reads through `MhLegacyStorageMigrationRun` / `Item`.
 *
 * Part 1 builds the PRE-rename objects (the DDL of `20260621030000_storage_provider_config`, with a
 * stub `storage_objects`) in a scratch schema placed first on the search_path, seeds rows, runs the
 * migration file verbatim and inspects the result. It can therefore run on a fully migrated database,
 * where public already holds the renamed tables and the platform's own `storage_migration_*`.
 *
 * Part 2 needs a database migrated to the latest schema (`npm run prisma:migrate`): it writes rows
 * into `public.mh_legacy_storage_migration_*` and reads them back through Prisma, beside the
 * platform's empty `storage_migration_runs`. (Since RETRO-D1 nothing in the app reads the legacy
 * tables: they are frozen history; the migration is the platform's.)
 *
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261108160000_rename_legacy_storage_migration_tables',
  'migration.sql',
);

/** The legacy objects as `20260621030000_storage_provider_config` created them (storage_objects stubbed). */
const PRE_RENAME_DDL = `
CREATE TABLE "storage_objects" ("id" UUID NOT NULL, CONSTRAINT "storage_objects_pkey" PRIMARY KEY ("id"));
CREATE TYPE "StorageMigrationStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
CREATE TYPE "StorageMigrationItemStatus" AS ENUM ('pending', 'copying', 'verified', 'completed', 'failed', 'skipped');
CREATE TABLE "storage_migration_runs" (
    "id" UUID NOT NULL,
    "source_provider" TEXT NOT NULL,
    "target_provider" TEXT NOT NULL,
    "status" "StorageMigrationStatus" NOT NULL DEFAULT 'pending',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "migrated_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "storage_migration_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "storage_migration_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "status" "StorageMigrationItemStatus" NOT NULL DEFAULT 'pending',
    "job_id" UUID,
    "new_storage_key" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "storage_migration_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "storage_migration_items_run_id_object_id_key" ON "storage_migration_items"("run_id", "object_id");
CREATE INDEX "storage_migration_items_status_idx" ON "storage_migration_items"("status");
ALTER TABLE "storage_migration_items" ADD CONSTRAINT "storage_migration_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "storage_migration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "storage_migration_items" ADD CONSTRAINT "storage_migration_items_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`;

type Row = Record<string, unknown>;

function newClient(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'appdb',
  });
}

describeMaybeDb('legacy storage-migration rename (DB_GATED: real PostgreSQL)', () => {
  describe('the migration on pre-rename tables', () => {
    let client: Client;
    const schema = `a5b_rename_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const ids = {
      object1: randomUUID(),
      object2: randomUUID(),
      object3: randomUUID(),
      runDone: randomUUID(),
      runActive: randomUUID(),
      item1: randomUUID(),
      item2: randomUUID(),
      item3: randomUUID(),
      job: randomUUID(),
      user: randomUUID(),
    };
    const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await client.query(sql, params)).rows;
    const inSchema = async (kind: 'table' | 'type' | 'index' | 'constraint'): Promise<string[]> => {
      const sql = {
        table: `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'`,
        type: `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype = 'e'`,
        index: `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'i'`,
        constraint: `SELECT co.conname AS name FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = $1`,
      }[kind];
      return (await q(sql, [schema])).map((r) => r['name'] as string).sort();
    };

    beforeAll(async () => {
      client = newClient();
      await client.connect();
      await q(`CREATE SCHEMA ${schema}`);
      await q(`SET search_path TO ${schema}, public`);
      await q(PRE_RENAME_DDL);

      await q(`INSERT INTO storage_objects (id) VALUES ($1), ($2), ($3)`, [ids.object1, ids.object2, ids.object3]);
      await q(
        `INSERT INTO storage_migration_runs (id, source_provider, target_provider, status, total_count, migrated_count,
           failed_count, skipped_count, started_at, finished_at, last_error, created_by_id, created_at)
         VALUES ($1, 's3', 'r2', 'completed', 2, 1, 1, 0, '2026-06-21T10:00:00Z', '2026-06-21T11:00:00Z', 'one failed', $3, '2026-06-21T09:00:00Z'),
                ($2, 'r2', 'local', 'running', 1, 0, 0, 0, '2026-07-01T10:00:00Z', NULL, NULL, NULL, '2026-07-01T09:00:00Z')`,
        [ids.runDone, ids.runActive, ids.user],
      );
      await q(
        `INSERT INTO storage_migration_items (id, run_id, object_id, status, job_id, new_storage_key, last_error, created_at, updated_at)
         VALUES ($1, $4, $6, 'completed', $9, 'r2/key-1', NULL, '2026-06-21T09:00:00Z', '2026-06-21T10:30:00Z'),
                ($2, $4, $7, 'failed', NULL, NULL, 'copy verification failed', '2026-06-21T09:00:00Z', '2026-06-21T10:40:00Z'),
                ($3, $5, $8, 'copying', NULL, NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-01T10:05:00Z')`,
        [ids.item1, ids.item2, ids.item3, ids.runDone, ids.runActive, ids.object1, ids.object2, ids.object3, ids.job],
      );

      await q(readFileSync(MIGRATION, 'utf8'));
    });

    afterAll(async () => {
      await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await client.end();
    });

    it('renames both tables and both enum types, leaving no old name behind', async () => {
      expect(await inSchema('table')).toEqual([
        'mh_legacy_storage_migration_items',
        'mh_legacy_storage_migration_runs',
        'storage_objects',
      ]);
      expect(await inSchema('type')).toEqual(['MhLegacyStorageMigrationItemStatus', 'MhLegacyStorageMigrationStatus']);
    });

    it('renames every key, foreign key and index to the names Prisma derives from the mapped tables', async () => {
      expect(await inSchema('index')).toEqual([
        'mh_legacy_storage_migration_items_pkey',
        'mh_legacy_storage_migration_items_run_id_object_id_key',
        'mh_legacy_storage_migration_items_status_idx',
        'mh_legacy_storage_migration_runs_pkey',
        'storage_objects_pkey',
      ]);
      expect(await inSchema('constraint')).toEqual([
        'mh_legacy_storage_migration_items_object_id_fkey',
        'mh_legacy_storage_migration_items_pkey',
        'mh_legacy_storage_migration_items_run_id_fkey',
        'mh_legacy_storage_migration_runs_pkey',
        'storage_objects_pkey',
      ]);
    });

    it('keeps every run row and value', async () => {
      const runs = await q(
        `SELECT id, source_provider, target_provider, status::text AS status, total_count, migrated_count, failed_count,
                skipped_count, started_at, finished_at, last_error, created_by_id, created_at
           FROM mh_legacy_storage_migration_runs ORDER BY created_at`,
      );
      expect(runs).toEqual([
        {
          id: ids.runDone,
          source_provider: 's3',
          target_provider: 'r2',
          status: 'completed',
          total_count: 2,
          migrated_count: 1,
          failed_count: 1,
          skipped_count: 0,
          started_at: new Date('2026-06-21T10:00:00Z'),
          finished_at: new Date('2026-06-21T11:00:00Z'),
          last_error: 'one failed',
          created_by_id: ids.user,
          created_at: new Date('2026-06-21T09:00:00Z'),
        },
        {
          id: ids.runActive,
          source_provider: 'r2',
          target_provider: 'local',
          status: 'running',
          total_count: 1,
          migrated_count: 0,
          failed_count: 0,
          skipped_count: 0,
          started_at: new Date('2026-07-01T10:00:00Z'),
          finished_at: null,
          last_error: null,
          created_by_id: null,
          created_at: new Date('2026-07-01T09:00:00Z'),
        },
      ]);
    });

    it('keeps every item row and value, with the enum labels of the old types', async () => {
      const items = await q(
        `SELECT id, run_id, object_id, status::text AS status, job_id, new_storage_key, last_error, updated_at
           FROM mh_legacy_storage_migration_items ORDER BY updated_at`,
      );
      expect(items).toEqual([
        { id: ids.item1, run_id: ids.runDone, object_id: ids.object1, status: 'completed', job_id: ids.job, new_storage_key: 'r2/key-1', last_error: null, updated_at: new Date('2026-06-21T10:30:00Z') },
        { id: ids.item2, run_id: ids.runDone, object_id: ids.object2, status: 'failed', job_id: null, new_storage_key: null, last_error: 'copy verification failed', updated_at: new Date('2026-06-21T10:40:00Z') },
        { id: ids.item3, run_id: ids.runActive, object_id: ids.object3, status: 'copying', job_id: null, new_storage_key: null, last_error: null, updated_at: new Date('2026-07-01T10:05:00Z') },
      ]);
      const labels = await q(
        `SELECT t.typname AS type, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = $1 GROUP BY t.typname ORDER BY t.typname`,
        [schema],
      );
      expect(labels).toEqual([
        { type: 'MhLegacyStorageMigrationItemStatus', labels: ['pending', 'copying', 'verified', 'completed', 'failed', 'skipped'] },
        { type: 'MhLegacyStorageMigrationStatus', labels: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
      ]);
    });

    it('keeps the constraints working: the unique key refuses a duplicate, both foreign keys still cascade', async () => {
      await expect(
        q(`INSERT INTO mh_legacy_storage_migration_items (id, run_id, object_id, updated_at) VALUES ($1, $2, $3, now())`, [
          randomUUID(),
          ids.runDone,
          ids.object1,
        ]),
      ).rejects.toThrow(/mh_legacy_storage_migration_items_run_id_object_id_key/);

      await q(`DELETE FROM storage_objects WHERE id = $1`, [ids.object3]);
      expect(await q(`SELECT id FROM mh_legacy_storage_migration_items WHERE id = $1`, [ids.item3])).toEqual([]);

      await q(`DELETE FROM mh_legacy_storage_migration_runs WHERE id = $1`, [ids.runDone]);
      expect(await q(`SELECT count(*)::int AS n FROM mh_legacy_storage_migration_items`)).toEqual([{ n: 0 }]);
    });
  });

  describe('the renamed tables read through the app models', () => {
    let prisma: PrismaService;
    let pg: Client;
    let ready = false;
    const ids = { object: randomUUID(), run: randomUUID(), item: randomUUID() };

    beforeAll(async () => {
      pg = newClient();
      await pg.connect();
      const have = await pg.query(
        `SELECT to_regclass('public.mh_legacy_storage_migration_runs') AS legacy, to_regclass('public.storage_migration_runs') AS platform`,
      );
      if (!have.rows[0].legacy || !have.rows[0].platform) {
        throw new Error('the database is not migrated through the A5b rename and platform 0042: run `npm run prisma:migrate` first');
      }
      ready = true;
      await pg.query(
        `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, org_id, updated_at)
         SELECT $1, 'a5b.jpg', 10, 'image/jpeg', $2, id, now() FROM organizations WHERE is_default`,
        [ids.object, `a5b-spec/${ids.object}`],
      );
      await pg.query(
        `INSERT INTO mh_legacy_storage_migration_runs (id, source_provider, target_provider, status, total_count, migrated_count)
         VALUES ($1, 's3', 'r2', 'completed', 1, 0)`,
        [ids.run],
      );
      await pg.query(
        `INSERT INTO mh_legacy_storage_migration_items (id, run_id, object_id, status, new_storage_key, updated_at)
         VALUES ($1, $2, $3, 'completed', 'r2/a5b', now())`,
        [ids.item, ids.run, ids.object],
      );
      prisma = new PrismaService();
      await prisma.$connect();
    });

    afterAll(async () => {
      if (ready) {
        await pg.query(`DELETE FROM mh_legacy_storage_migration_runs WHERE id = $1`, [ids.run]);
        await pg.query(`DELETE FROM storage_objects WHERE id = $1`, [ids.object]);
      }
      await prisma?.$disconnect();
      await pg.end();
    });

    it('MhLegacyStorageMigrationRun / Item map onto mh_legacy_*, with the object relation', async () => {
      const run = await prisma.mhLegacyStorageMigrationRun.findUnique({
        where: { id: ids.run },
        include: { items: { include: { object: { select: { id: true } } } } },
      });
      expect(run).toMatchObject({ id: ids.run, sourceProvider: 's3', targetProvider: 'r2', status: 'completed' });
      expect(run!.items).toHaveLength(1);
      expect(run!.items[0]).toMatchObject({ id: ids.item, status: 'completed', newStorageKey: 'r2/a5b', object: { id: ids.object } });
    });

    it('leaves the platform storage_migration_* tables alone', async () => {
      const rows = await pg.query(`SELECT count(*)::int AS n FROM storage_migration_items WHERE id = $1`, [ids.item]);
      expect(rows.rows).toEqual([{ n: 0 }]);
    });
  });
});
