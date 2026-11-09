/**
 * Real-Postgres tier (RETRO-D1, #563): `storage_objects` is isolated per
 * organization by FORCEd row-level security, and the paths the storage slice
 * uses honour it.
 *
 *   - An object written in organization A is invisible from organization B,
 *     both through raw transactions (`set_config('app.org_id', ..., true)`) and
 *     through `PrismaService.forOrg` / `runInOrg` (what the platform slice calls).
 *   - The system client (`PrismaSystemService.asSystem`, a named reason) sees
 *     both organizations' rows.
 *
 * RLS is inert for a superuser or a BYPASSRLS role. When the test connects as
 * one (the usual CI database), every isolation read runs under `SET LOCAL ROLE`
 * of a probe role created here (NOBYPASSRLS, granted only on the two storage
 * tables); when it connects as the application role (the table owner, FORCE RLS
 * applies), it reads directly. The `forOrg` cases need the latter and are
 * reported in the test name.
 *
 * Skips (reported as skipped, never passed) when no database is reachable.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { buildBaseDatabaseUrl } from '../../src/config/database-url.util';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PrismaSystemService } from '../../src/prisma/prisma-system.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const PROBE_ROLE = 'mh_rls_probe_storage';

describeMaybeDb('storage_objects row-level security (DB_GATED: real PostgreSQL)', () => {
  let pg: Client;
  let prisma: PrismaService;
  let system: PrismaSystemService;
  let bypassing = false;
  let orgA: string;
  let orgB: string;
  const objectA = randomUUID();
  const objectB = randomUUID();

  /** One transaction in `orgId`'s scope, as the probe role when the connection bypasses RLS. */
  async function inOrg<T>(orgId: string, sql: string, params: unknown[]): Promise<T[]> {
    await pg.query('BEGIN');
    try {
      await pg.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      if (bypassing) await pg.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
      const res = await pg.query(sql, params);
      await pg.query('COMMIT');
      return res.rows as T[];
    } catch (error) {
      await pg.query('ROLLBACK');
      throw error;
    }
  }

  async function asBypass(sql: string, params: unknown[] = []): Promise<void> {
    await pg.query('BEGIN');
    await pg.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
    await pg.query(sql, params);
    await pg.query('COMMIT');
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: buildBaseDatabaseUrl() });
    await pg.connect();
    const role = await pg.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    bypassing = role.rows[0]!.rolsuper || role.rows[0]!.rolbypassrls;
    if (bypassing) {
      await pg.query(`DO $$ BEGIN CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      await pg.query(`GRANT SELECT, INSERT ON storage_objects TO ${PROBE_ROLE}`);
    }
    const def = await pg.query<{ id: string }>(`SELECT id::text AS id FROM organizations WHERE is_default LIMIT 1`);
    if (def.rows.length === 0) throw new Error('no default organization: run the migrations first');
    orgA = def.rows[0]!.id;
    orgB = randomUUID();
    await asBypass(
      `INSERT INTO organizations (id, name, slug, is_default, updated_at) VALUES ($1::uuid, 'Org Beta', $2, false, now())`,
      [orgB, `org-beta-${orgB.slice(0, 8)}`],
    );
    for (const [id, org] of [
      [objectA, orgA],
      [objectB, orgB],
    ] as const) {
      await asBypass(
        `INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
         VALUES ($1::uuid, $2::uuid, 'photo.jpg', 10, 'image/jpeg', $3, 'local', 'ready', now())`,
        [id, org, `uploads/rls/${id}.jpg`],
      );
    }
    prisma = new PrismaService();
    await prisma.$connect();
    system = new PrismaSystemService();
    await system.$connect();
  });

  afterAll(async () => {
    if (pg) {
      await asBypass(`DELETE FROM storage_objects WHERE id = ANY($1::uuid[])`, [[objectA, objectB]]).catch(() => undefined);
      await asBypass(`DELETE FROM organizations WHERE id = $1::uuid`, [orgB]).catch(() => undefined);
      if (bypassing) {
        await pg.query(`REVOKE ALL ON storage_objects FROM ${PROBE_ROLE}`).catch(() => undefined);
        await pg.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => undefined);
      }
      await pg.end();
    }
    await prisma?.$disconnect();
    await system?.$disconnect();
  });

  it('forces row-level security on storage_objects and storage_object_chunks', async () => {
    const res = await pg.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('storage_objects', 'storage_object_chunks') ORDER BY relname`,
    );
    expect(res.rows).toEqual([
      { relname: 'storage_object_chunks', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'storage_objects', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("an organization reads its own object and never another organization's", async () => {
    const fromA = await inOrg<{ id: string }>(orgA, `SELECT id::text AS id FROM storage_objects WHERE id = ANY($1::uuid[])`, [
      [objectA, objectB],
    ]);
    expect(fromA.map((r) => r.id)).toEqual([objectA]);
    const fromB = await inOrg<{ id: string }>(orgB, `SELECT id::text AS id FROM storage_objects WHERE id = ANY($1::uuid[])`, [
      [objectA, objectB],
    ]);
    expect(fromB.map((r) => r.id)).toEqual([objectB]);
  });

  it('a transaction with no organization sees nothing', async () => {
    await pg.query('BEGIN');
    try {
      if (bypassing) await pg.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
      const res = await pg.query(`SELECT id FROM storage_objects WHERE id = ANY($1::uuid[])`, [[objectA, objectB]]);
      expect(res.rows).toEqual([]);
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('refuses to write a row into another organization', async () => {
    await expect(
      inOrg(orgB, `INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, storage_provider, status, updated_at)
        VALUES ($1::uuid, $2::uuid, 'x.jpg', 1, 'image/jpeg', $3, 'local', 'ready', now())`, [
        randomUUID(),
        orgA,
        `uploads/rls/${randomUUID()}.jpg`,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it('PrismaService.forOrg / runInOrg scope the slice\'s reads (meaningful when the API role is not a superuser)', async () => {
    const viaForOrg = await prisma.forOrg(orgA).storageObject.findMany({ where: { id: { in: [objectA, objectB] } }, select: { id: true } });
    const viaRunInOrg = await prisma.runInOrg(orgA, (tx) =>
      tx.storageObject.findMany({ where: { id: { in: [objectA, objectB] } }, select: { id: true } }),
    );
    if (bypassing) {
      // A superuser connection bypasses RLS: both rows are visible whatever the scope.
      expect(viaForOrg.map((r) => r.id).sort()).toEqual([objectA, objectB].sort());
    } else {
      expect(viaForOrg.map((r) => r.id)).toEqual([objectA]);
      expect(viaRunInOrg.map((r) => r.id)).toEqual([objectA]);
    }
  });

  it('the system client (named reason) reads across organizations', async () => {
    const rows = await system
      .asSystem('admin-aggregate')
      .storageObject.findMany({ where: { id: { in: [objectA, objectB] } }, select: { id: true } });
    expect(rows.map((r) => r.id).sort()).toEqual([objectA, objectB].sort());
  });
});
