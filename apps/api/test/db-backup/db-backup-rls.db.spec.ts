/**
 * Real-Postgres tier (RETRO-D4, #580): what the db-backup cutover claims, proven on a server.
 *
 *   1. RLS. The platform engine's dump (`spawnPgDump`: `--enable-row-security` AND
 *      `PGOPTIONS=-c app.rls_bypass=on`) of a database whose table FORCES row-level security,
 *      taken as an ORDINARY role (a superuser ignores every policy and would pass a broken dump),
 *      restores with every row. NEGATIVE CONTROL: the flag without the option exits 0 and restores
 *      to an EMPTY table — the silent failure MemoriaHub's pre-slice dumps would have had once
 *      `storage_objects` forces RLS (it does on this schema: asserted).
 *   2. History. The data transform copies `mh_legacy_database_backup_runs` rows that point at an
 *      archive into `database_backup_runs` under their ids (legacy `db-backups/` keys untouched),
 *      skips rows without an archive, re-resolves users, maps unpublished restore statuses to NULL,
 *      links the pre-restore self-reference, and copies nothing on a second run.
 *   3. Carry-over. The Android releases carry's export and re-insert SQL move a newer current
 *      release onto an older promoted database without tripping the one-current partial index.
 *   4. Gate. `memoriahub-extensions` passes on a cluster that offers pgvector.
 *
 * Needs a migrated database (`npm run prisma:migrate`) reachable through POSTGRES_* as a role that
 * may create roles and databases (the bootstrap superuser). Skips, logged, otherwise.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Client } from 'pg';

import {
  PG_DUMP_COMMAND,
  buildPgDumpArgs,
  buildRestoreGateContext,
  pgClientEnv,
  spawnPgDump,
  spawnPgProcess,
  spawnPgRestore,
  type PgConnection,
} from '@marinoscar/platform-api/db-backup/testing';

import { ANDROID_RELEASES_CARRY_OVER, checkMemoriaHubExtensions } from '../../src/app-registrations/db-backup';
import { applyRunCopy, planRunCopy } from '../../src/legacy/legacy-db-backup-migration';

const SUFFIX = randomUUID().slice(0, 8);
const ROLE = `mh_d4_app_${SUFFIX}`;
const ROLE_PASSWORD = `pw_${SUFFIX}`;
const SOURCE_DB = `mh_d4_src_${SUFFIX}`;
const TARGET_DB = `mh_d4_dst_${SUFFIX}`;
const EMPTY_DB = `mh_d4_neg_${SUFFIX}`;
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';

function base(): Omit<PgConnection, 'database'> & { database: string } {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || '5432',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'appdb',
    sslMode: null,
  };
}

async function connect(conn: PgConnection, options?: string): Promise<Client> {
  const client = new Client({
    host: conn.host,
    port: Number(conn.port),
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: 2000,
    ...(options ? { options } : {}),
  });
  await client.connect();
  return client;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('db-backup cutover (real Postgres)', () => {
  let admin: Client | null = null;
  const app = (): PgConnection => ({ ...base(), user: ROLE, password: ROLE_PASSWORD, database: SOURCE_DB });

  beforeAll(async () => {
    try {
      const candidate = await connect(base());
      const have = await candidate.query(
        `SELECT to_regclass('public.database_backup_runs') AS runs,
                to_regclass('public.mh_legacy_database_backup_runs') AS legacy,
                (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS can_create`,
      );
      if (!have.rows[0].runs || !have.rows[0].legacy) throw new Error('not migrated: run `npm run prisma:migrate` first');
      if (!have.rows[0].can_create) throw new Error('the connecting role cannot create roles');
      admin = candidate;
    } catch (err) {
      console.warn(`Skipping db-backup-rls.db.spec: ${(err as Error).message}`);
      return;
    }

    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    for (const db of [SOURCE_DB, TARGET_DB, EMPTY_DB]) await admin.query(`CREATE DATABASE ${db} OWNER ${ROLE}`);

    // The source database, built by its ordinary owner: a table that FORCES row-level security
    // with the platform's policy shape (organization scope, or the transaction/session bypass).
    const owner = await connect(app());
    try {
      await owner.query(`
        CREATE TABLE storage_objects (id uuid PRIMARY KEY, org_id uuid NOT NULL, name text NOT NULL);
        ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;
        ALTER TABLE storage_objects FORCE ROW LEVEL SECURITY;
        CREATE POLICY org_isolation ON storage_objects
          USING (current_setting('app.rls_bypass', true) = 'on'
                 OR org_id::text = current_setting('app.org_id', true))
          WITH CHECK (current_setting('app.rls_bypass', true) = 'on'
                 OR org_id::text = current_setting('app.org_id', true));`);
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
      for (const org of [ORG_A, ORG_A, ORG_A, ORG_B, ORG_B]) {
        await owner.query('INSERT INTO storage_objects VALUES ($1, $2, $3)', [randomUUID(), org, `object-${org}`]);
      }
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    for (const db of [SOURCE_DB, TARGET_DB, EMPTY_DB]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await admin.end();
  }, 60_000);

  /** Rows per organization in `database`, counted as the owner with the bypass on. */
  async function countsIn(database: string): Promise<Record<string, number>> {
    const client = await connect({ ...app(), database }, '-c app.rls_bypass=on');
    try {
      const { rows } = await client.query<{ org: string; n: number }>(
        'SELECT org_id::text AS org, count(*)::int AS n FROM storage_objects GROUP BY org_id ORDER BY 1',
      );
      return Object.fromEntries(rows.map((r) => [r.org, r.n]));
    } finally {
      await client.end();
    }
  }

  async function restoreInto(archive: Buffer, database: string): Promise<void> {
    const process = spawnPgRestore({ connection: { ...app(), database }, stdin: Readable.from([archive]) });
    process.stdout.resume();
    await process.done;
  }

  describe('row-level security', () => {
    it('the real schema forces row-level security on storage_objects (why the flags matter)', async () => {
      if (!admin) return;
      const { rows } = await admin.query(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.storage_objects'::regclass`,
      );
      expect(rows[0].relforcerowsecurity).toBe(true);
    });

    it('the ordinary owner sees nothing without a scope (the policy is in force)', async () => {
      if (!admin) return;
      const client = await connect(app());
      try {
        const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM storage_objects');
        expect(rows[0].n).toBe(0);
      } finally {
        await client.end();
      }
    });

    it("the platform engine's dump restores every row of every organization", async () => {
      if (!admin) return;
      const dump = spawnPgDump({ connection: app() });
      const [archive] = await Promise.all([collect(dump.stdout), dump.done]);
      await restoreInto(archive, TARGET_DB);
      expect(await countsIn(TARGET_DB)).toEqual({ [ORG_A]: 3, [ORG_B]: 2 });
    }, 60_000);

    it('NEGATIVE CONTROL: --enable-row-security without app.rls_bypass exits 0 and restores an EMPTY table', async () => {
      if (!admin) return;
      const withoutOption = spawnPgProcess({
        command: PG_DUMP_COMMAND,
        args: buildPgDumpArgs({ connection: app() }),
        password: ROLE_PASSWORD,
        extraEnv: pgClientEnv(app()),
      });
      const [archive] = await Promise.all([collect(withoutOption.stdout), withoutOption.done]);
      expect(archive.length).toBeGreaterThan(0);
      await restoreInto(archive, EMPTY_DB);
      expect(await countsIn(EMPTY_DB)).toEqual({});
    }, 60_000);
  });

  describe('legacy run history', () => {
    const ids = {
      completed: randomUUID(),
      preRestore: randomUUID(),
      noArchive: randomUUID(),
      guided: randomUUID(),
    };

    afterAll(async () => {
      if (!admin) return;
      const all = Object.values(ids);
      await admin.query('DELETE FROM database_backup_runs WHERE id = ANY($1::uuid[])', [all]);
      await admin.query('UPDATE mh_legacy_database_backup_runs SET pre_restore_backup_id = NULL WHERE id = ANY($1::uuid[])', [all]);
      await admin.query('DELETE FROM mh_legacy_database_backup_runs WHERE id = ANY($1::uuid[])', [all]);
    });

    it('copies archive rows by id, keeps their legacy keys, and is idempotent', async () => {
      if (!admin) return;
      const insert = `INSERT INTO mh_legacy_database_backup_runs
        (id, status, trigger, started_at, finished_at, bytes_written, size_bytes, storage_provider, storage_key, bucket,
         format, checksum_sha256, migration_name, verified_at, restore_status, pre_restore_backup_id)
        VALUES ($1, $2::"MhLegacyDatabaseBackupStatus", $3::"MhLegacyDatabaseBackupTrigger", now() - interval '1 day', now(),
                $4, $5, $6, $7, $8, 'custom', $9, '20261108040000_cutover_enrichment_jobs_to_jobs', now(), $10, $11)`;
      await admin.query(insert, [ids.preRestore, 'completed', 'pre_restore', 10, 10, 's3', `db-backups/20260101T000000Z-${ids.preRestore}.dump`, 'old-bucket', 'a'.repeat(64), null, null]);
      await admin.query(insert, [ids.completed, 'completed', 'scheduled', 20, 20, 'r2', `db-backups/20260102T000000Z-${ids.completed}.dump`, 'r2-bucket', 'b'.repeat(64), 'completed', ids.preRestore]);
      await admin.query(insert, [ids.guided, 'completed', 'manual', 30, 30, 's3', `db-backups/20260103T000000Z-${ids.guided}.dump`, null, 'c'.repeat(64), 'guided', null]);
      await admin.query(insert, [ids.noArchive, 'failed', 'manual', 0, null, null, null, null, null, null, null]);

      const before = await planRunCopy(admin);
      expect(before.active).toEqual([]);
      expect(before.toCopy).toBeGreaterThanOrEqual(3);

      const first = await applyRunCopy(admin);
      expect(first.copied).toBeGreaterThanOrEqual(3);

      const { rows } = await admin.query(
        `SELECT id::text, status::text, trigger::text, storage_provider, storage_key, bucket, size_bytes::text,
                restore_status, pre_restore_backup_id::text AS pre
         FROM database_backup_runs WHERE id = ANY($1::uuid[]) ORDER BY storage_key`,
        [Object.values(ids)],
      );
      expect(rows.map((r) => r.id)).toEqual([ids.preRestore, ids.completed, ids.guided]);
      const [pre, completed, guided] = rows;
      expect(pre).toMatchObject({ status: 'completed', trigger: 'pre_restore', storage_provider: 's3', bucket: 'old-bucket', size_bytes: '10' });
      expect(completed).toMatchObject({ storage_provider: 'r2', storage_key: `db-backups/20260102T000000Z-${ids.completed}.dump`, restore_status: 'completed', pre: ids.preRestore });
      expect(guided).toMatchObject({ restore_status: null, bucket: '' });

      const second = await applyRunCopy(admin);
      expect(second).toEqual({ copied: 0, linked: 0 });

      // The legacy table is untouched.
      const legacy = await admin.query('SELECT count(*)::int AS n FROM mh_legacy_database_backup_runs WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
      expect(legacy.rows[0].n).toBe(4);
    });
  });

  describe('Android releases carry-over', () => {
    it('moves a newer current release onto an older promoted database without two current rows', async () => {
      if (!admin) return;
      const older = randomUUID();
      const newer = randomUUID();
      const pkg = `example.test.carry${SUFFIX}`;
      const row = (id: string, code: number, current: boolean) => ({
        id,
        package_name: pkg,
        version_name: `1.0.${code}`,
        version_code: code,
        signing_sha256: 'AA:BB',
        file_sha256: 'f'.repeat(64),
        size_bytes: 1000,
        storage_key: `android-releases/${id}.apk`,
        storage_provider: 's3',
        bucket: 'apk-bucket',
        notes: null,
        is_current: current,
        uploaded_by_id: randomUUID(), // a user the promoted database does not know
        created_at: new Date(Date.now() - code * 1000).toISOString(),
      });

      await admin.query('BEGIN');
      try {
        // The promoted (older) database: only the older release, and it is current.
        await admin.query(
          `INSERT INTO mh_legacy_android_app_releases (id, package_name, version_name, version_code, signing_sha256, file_sha256,
             size_bytes, storage_key, is_current) VALUES ($1, $2, '1.0.1', 1, 'AA:BB', $3, 1000, $4, true)`,
          [older, pkg, 'f'.repeat(64), `android-releases/${older}.apk`],
        );
        // The displaced (newer) database exported, in the carry's order: the losing current row first.
        const exported = [row(older, 1, false), row(newer, 2, true)];
        for (const carried of exported) await admin.query(ANDROID_RELEASES_CARRY_OVER.reinsertSql, [JSON.stringify(carried)]);

        const { rows } = await admin.query(
          'SELECT id::text, is_current, uploaded_by_id FROM mh_legacy_android_app_releases WHERE package_name = $1 ORDER BY version_code',
          [pkg],
        );
        expect(rows).toEqual([
          { id: older, is_current: false, uploaded_by_id: null },
          { id: newer, is_current: true, uploaded_by_id: null },
        ]);
        // The export statement is valid against the real table.
        await admin.query(ANDROID_RELEASES_CARRY_OVER.exportSql);
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  describe('memoriahub-extensions gate', () => {
    it('passes on a cluster that offers pgvector', async () => {
      if (!admin) return;
      const ctx = buildRestoreGateContext();
      const b = base();
      const outcome = await checkMemoriaHubExtensions(
        buildRestoreGateContext({
          facts: { ...ctx.facts, connection: { host: b.host, port: b.port, user: b.user, database: 'postgres', liveDatabase: b.database } },
        }),
      );
      expect(outcome.status).toBe('pass');
    });
  });
});
