/**
 * Real-Postgres tier (RETRO-I3, #573): a user in several groups sees the UNION of them, everyone
 * else sees nothing of them (404, never 403), and the list queries that decide it use the indexes.
 *
 * As the application role (NOSUPERUSER NOBYPASSRLS) over a library big enough that the planner has a
 * real choice (34 groups of 400 items, one personal library):
 *
 *   1. `m` is a member of three groups: `accessibleWhere` (scope `all`) returns exactly their items plus
 *      their personal library's, never a fourth group's;
 *   2. `n` (one other group) sees only that group's items; `x` (no group) sees none: an empty list,
 *      not an error;
 *   3. `OwnerAccessService.requireOwnerRole`: a non-member (and a user of another group) is refused with
 *      404, an unknown group is 404, a member below the required role is 403 (membership is not a secret to a
 *      member), and the member passes;
 *   4. EXPLAIN (FORMAT JSON) of the REAL statements the app sends (captured from Prisma's query log, plus
 *      the raw `accessibleSql` fragment): the gallery keyset list (`circle_id IN (...)`), the
 *      `ownedByMeOrMyGroups` list and the `accessibleWhere` list never read `media_items` with a sequential
 *      scan, and name the index they use. The plans are printed to the test output. With an
 *      `ORDER BY captured_at DESC ... LIMIT 50` the planner walks `media_items_captured_at_idx` backwards and
 *      filters on the owner (cheap for a caller owning ~9% of the table, as here); the unordered
 *      owner lookups (4e) are served by the owner indexes, which is what a selective caller gets.
 *
 * Skips (reported as skipped) when nothing listens on the configured port.
 */
import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrincipalGroupsProvider,
  accessibleSql,
  accessibleWhere,
  ownedByMeOrMyGroups,
  resolveSharingModuleOptions,
} from '@marinoscar/platform-api/sharing';
import type { UserPrincipal } from '@marinoscar/platform-api/core';
import { Client } from 'pg';

import { createPersonalLibrary, createSharedLibrary, dropLibraries } from '../helpers/library';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { PersonalLibraryStore } from '../../src/platform/sharing/personal-library.store';
import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { SharingDataAdapter } from '../../src/platform/sharing/sharing-data.adapter';
import '../../src/app-registrations/sharing';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { inOrgTransaction, orgScoped } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

function connection(user?: { name: string; secret: string }) {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: user?.name ?? (process.env.POSTGRES_USER || 'postgres'),
    password: user?.secret ?? (process.env.POSTGRES_PASSWORD || 'postgres'),
    database: process.env.POSTGRES_DB || 'appdb',
  };
}

function url(user: { name: string; secret: string }): string {
  const c = connection(user);
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`;
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

describeMaybeDb('RETRO-I3 multi-group union and its query plans (DB_GATED: real PostgreSQL)', () => {
  // A throwaway role; its secret is random per run, never a fixed literal.
  const role = { name: `i3c_app_${randomUUID().replace(/-/g, '').slice(0, 8)}`, secret: randomUUID() };
  const tag = randomUUID().slice(0, 8);
  const users = { m: randomUUID(), n: randomUUID(), x: randomUUID(), filler: randomUUID() };
  const g = { one: randomUUID(), two: randomUUID(), three: randomUUID(), other: randomUUID() };
  const personal = randomUUID();
  const fillers = Array.from({ length: 30 }, () => randomUUID());
  const PER_LIBRARY = 400;
  const everyLibrary = [...Object.values(g), personal, ...fillers];

  let admin: Client;
  let planner: Client;
  let app: PrismaClient;
  let groups: PrincipalGroupsProvider;
  let access: OwnerAccessService;
  let data: SharingDataAdapter;
  let orgId: string;
  const captured: Array<{ query: string; params: string }> = [];

  const principal = (userId: string): UserPrincipal => ({
    kind: 'user',
    userId,
    email: '',
    credential: 'session',
    roles: [],
    permissions: [],
    activeOrgId: orgId,
  });

  /** Every seeded item id by library, read as the owner role under the default organization's scope. */
  async function idsOf(libraries: string[]): Promise<Set<string>> {
    const rows = await orgScoped(admin).query(`SELECT id::text AS id FROM media_items WHERE circle_id = ANY($1::uuid[])`, [libraries]);
    return new Set(rows.rows.map((r) => r.id as string));
  }

  async function visible(userId: string): Promise<Set<string>> {
    const me = await groups.enrich(principal(userId));
    const seeded = [...(await idsOf(everyLibrary))];
    const ids = await data.runInOrg({ orgId, userId }, async (rawTx) => {
      const tx = rawTx as Prisma.TransactionClient;
      const decided = await accessibleWhere(me, 'media_item', { tx, sqlKit: Prisma, scope: 'all' });
      if (decided.form !== 'where') throw new Error('unexpected EXISTS form');
      const rows = await tx.mediaItem.findMany({
        where: { AND: [decided.where as Prisma.MediaItemWhereInput, { id: { in: seeded } }] },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    });
    return new Set(ids);
  }

  beforeAll(async () => {
    admin = new Client(connection());
    await admin.connect();
    orgId = (await orgScoped(admin).query(`SELECT id::text AS id FROM organizations WHERE is_default`)).rows[0].id;

    await orgScoped(admin).query(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.secret}' NOSUPERUSER NOBYPASSRLS`);
    await orgScoped(admin).query(`GRANT USAGE ON SCHEMA public TO ${role.name}`);
    await orgScoped(admin).query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role.name}`);

    for (const [key, id] of Object.entries(users)) {
      await orgScoped(admin).query(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [id, `${key}-${tag}@example.test`]);
    }
    // m: viewer of `three`, editor of `two`, admin of `one`; n: only `other`; x: nobody.
    await createSharedLibrary(admin, {
      id: g.one,
      name: `Union One ${tag}`,
      createdById: users.m,
      members: [{ userId: users.m, role: 'admin' }],
    });
    await createSharedLibrary(admin, {
      id: g.two,
      name: `Union Two ${tag}`,
      createdById: users.filler,
      members: [
        { userId: users.filler, role: 'admin' },
        { userId: users.m, role: 'editor' },
      ],
    });
    await createSharedLibrary(admin, {
      id: g.three,
      name: `Union Three ${tag}`,
      createdById: users.filler,
      members: [
        { userId: users.filler, role: 'admin' },
        { userId: users.m, role: 'viewer' },
      ],
    });
    await createSharedLibrary(admin, {
      id: g.other,
      name: `Union Other ${tag}`,
      createdById: users.n,
      members: [{ userId: users.n, role: 'admin' }],
    });
    for (const id of fillers) {
      await createSharedLibrary(admin, { id, name: `Union Filler ${id.slice(0, 8)}`, createdById: users.filler });
    }
    await createPersonalLibrary(admin, { id: personal, userId: users.m });

    // PER_LIBRARY items in every library, in one transaction under the default organization's scope.
    await inOrgTransaction(admin, async (c) => {
      await c.query(
        `CREATE TEMP TABLE i3c_seed ON COMMIT DROP AS
           SELECT gen_random_uuid() AS object_id, l AS circle_id, n,
                  CASE WHEN l = $3::uuid THEN $2::uuid ELSE $1::uuid END AS added_by
             FROM unnest($4::uuid[]) AS l, generate_series(1, $5::int) AS n`,
        [users.filler, users.m, personal, everyLibrary, PER_LIBRARY],
      );
      await c.query(
        `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id, status)
         SELECT object_id, 'photo.jpg', 1000, 'image/jpeg', 'seed/i3c/' || object_id, now(), $1::uuid, 'ready' FROM i3c_seed`,
        [orgId],
      );
      await c.query(
        `INSERT INTO media_items (storage_object_id, added_by_id, updated_at, type, source, original_filename, circle_id, content_hash, captured_at)
         SELECT object_id, added_by, now(), 'photo', 'web', 'photo.jpg', circle_id, md5(object_id::text),
                now() - (n || ' minutes')::interval
           FROM i3c_seed`,
      );
    });
    await orgScoped(admin).query(`ANALYZE media_items`);

    captured.length = 0;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url(role), max: 2 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    (app as unknown as { $on: (e: 'query', f: (q: { query: string; params: string }) => void) => void }).$on('query', (event) =>
      captured.push({ query: event.query, params: event.params }),
    );
    const options = resolveSharingModuleOptions({
      ...SHARING_MODULE_OPTIONS,
      groups: { ...SHARING_MODULE_OPTIONS.groups, membershipCacheTtlSeconds: 0 },
    });
    data = new SharingDataAdapter(app as never, {} as never);
    groups = new PrincipalGroupsProvider(data, options);
    access = new OwnerAccessService(new PersonalLibraryStore(app as never), groups, { get: async () => orgId } as never);

    planner = new Client(connection(role));
    await planner.connect();
  }, 180_000);

  afterAll(async () => {
    await planner?.end();
    await app?.$disconnect();
    if (admin) {
      await orgScoped(admin).query(`DELETE FROM media_items WHERE circle_id = ANY($1::uuid[])`, [everyLibrary]).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM storage_objects WHERE storage_key LIKE 'seed/i3c/%'`).catch(() => undefined);
      await dropLibraries(admin, everyLibrary).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]).catch(() => undefined);
      await orgScoped(admin).query(`DROP OWNED BY ${role.name}`).catch(() => undefined);
      await orgScoped(admin).query(`DROP ROLE IF EXISTS ${role.name}`).catch(() => undefined);
      await admin.end();
    }
  });

  it('1. a user in three groups sees the union of the three and their personal library, never a fourth group', async () => {
    const expected = await idsOf([g.one, g.two, g.three, personal]);
    expect(expected.size).toBe(4 * PER_LIBRARY);
    const seen = await visible(users.m);
    expect(seen).toEqual(expected);
    for (const hidden of await idsOf([g.other, ...fillers])) expect(seen.has(hidden)).toBe(false);
  });

  it('2. another user sees only their own group; a user of no group sees nothing (an empty list, not an error)', async () => {
    expect(await visible(users.n)).toEqual(await idsOf([g.other]));
    expect((await visible(users.x)).size).toBe(0);
  });

  it('3. a non-member is refused with 404 (never 403), an unknown group is 404, a member below the role is 403', async () => {
    for (const who of [users.x, users.n]) {
      for (const library of [g.one, g.two, g.three, personal]) {
        await expect(access.requireOwnerRole(who, library, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
      }
    }
    await expect(access.requireOwnerRole(users.m, randomUUID(), [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
    // m holds admin / editor / viewer in the three groups.
    await expect(access.requireOwnerRole(users.m, g.one, [], 'admin')).resolves.toMatchObject({ role: 'admin' });
    await expect(access.requireOwnerRole(users.m, g.two, [], 'editor')).resolves.toMatchObject({ role: 'editor' });
    await expect(access.requireOwnerRole(users.m, g.three, [], 'viewer')).resolves.toMatchObject({ role: 'viewer' });
    await expect(access.requireOwnerRole(users.m, g.three, [], 'editor')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(access.requireOwnerRole(users.m, g.two, [], 'admin')).rejects.toBeInstanceOf(ForbiddenException);
  });

  /** EXPLAIN (FORMAT JSON) of one statement as the application role under m's organization and user scope. */
  async function explain(sql: string, params: unknown[]): Promise<PlanNode> {
    await planner.query('BEGIN');
    try {
      await planner.query(`SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, [orgId, users.m]);
      const result = await planner.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      return (result.rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
    } finally {
      await planner.query('ROLLBACK');
    }
  }

  function summary(plan: PlanNode): { relationScans: string[]; indexes: string[]; totalCost: number | undefined } {
    const relationScans: string[] = [];
    const indexes: string[] = [];
    walk(plan, (node) => {
      if (node['Relation Name'] === 'media_items') relationScans.push(node['Node Type']);
      if (node['Index Name']) indexes.push(node['Index Name']);
    });
    return { relationScans, indexes: [...new Set(indexes)], totalCost: plan['Total Cost'] };
  }

  /** The statement the app sent for the last `media_items` list, with its bound parameters. */
  function lastListStatement(): { sql: string; params: unknown[] } {
    const hit = [...captured].reverse().find((q) => /FROM "public"\."media_items"/.test(q.query) && /LIMIT/.test(q.query));
    if (!hit) throw new Error('no media_items list statement was captured');
    return { sql: hit.query, params: JSON.parse(hit.params) as unknown[] };
  }

  function assertIndexed(label: string, plan: PlanNode, allowedIndexes: RegExp): void {
    const seen = summary(plan);
    // eslint-disable-next-line no-console
    console.log(`EXPLAIN ${label}: ${JSON.stringify(seen)}\n${JSON.stringify(plan, null, 2)}`);
    expect(seen.relationScans).not.toContain('Seq Scan');
    expect(seen.indexes.some((name) => allowedIndexes.test(name))).toBe(true);
  }

  it('4a. the gallery keyset list over the caller\'s scopes (circle_id IN ...) is index-driven', async () => {
    const scopes = await access.scopesOf(users.m);
    expect(new Set(scopes)).toEqual(new Set([g.one, g.two, g.three, personal]));
    captured.length = 0;
    await data.runInOrg({ orgId, userId: users.m }, async (rawTx) => {
      const tx = rawTx as Prisma.TransactionClient;
      await tx.mediaItem.findMany({
        where: { circleId: { in: scopes }, deletedAt: null, archivedAt: null },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { id: true },
      });
    });
    const { sql, params } = lastListStatement();
    assertIndexed('gallery (circle_id IN scopes, keyset)', await explain(sql, params), /^media_items_(gallery|circle_id|captured_at)_idx$/);
  });

  it('4b. the ownedByMeOrMyGroups list is index-driven (owner_user_id OR owner_group_id)', async () => {
    const me = await groups.enrich(principal(users.m));
    captured.length = 0;
    await data.runInOrg({ orgId, userId: users.m }, async (rawTx) => {
      const tx = rawTx as Prisma.TransactionClient;
      await tx.mediaItem.findMany({
        where: {
          AND: [
            ownedByMeOrMyGroups(me, { ownerUserField: 'ownerUserId', ownerGroupField: 'ownerGroupId' }) as Prisma.MediaItemWhereInput,
            { deletedAt: null },
          ],
        },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { id: true },
      });
    });
    const { sql, params } = lastListStatement();
    assertIndexed('ownedByMeOrMyGroups', await explain(sql, params), /^media_items_(owner_(user|group)_id|captured_at)_idx$/);
  });

  it('4c. the accessibleWhere list (owner scope plus grants) never scans media_items sequentially', async () => {
    const me = await groups.enrich(principal(users.m));
    captured.length = 0;
    await data.runInOrg({ orgId, userId: users.m }, async (rawTx) => {
      const tx = rawTx as Prisma.TransactionClient;
      const decided = await accessibleWhere(me, 'media_item', { tx, sqlKit: Prisma, scope: 'all' });
      if (decided.form !== 'where') throw new Error('unexpected EXISTS form');
      await tx.mediaItem.findMany({
        where: { AND: [decided.where as Prisma.MediaItemWhereInput, { deletedAt: null }] },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { id: true },
      });
    });
    const { sql, params } = lastListStatement();
    assertIndexed('accessibleWhere (scope all)', await explain(sql, params), /^media_items_(owner_(user|group)_id|gallery|circle_id|captured_at)_idx$/);
  });

  it('4d. the raw accessibleSql fragment is index-driven too', async () => {
    const me = await groups.enrich(principal(users.m));
    const fragment = accessibleSql(me, 'media_item', 'r', { sqlKit: Prisma, scope: 'all' }) as Prisma.Sql;
    const statement = Prisma.sql`SELECT r.id FROM media_items r WHERE ${fragment} AND r.deleted_at IS NULL ORDER BY r.captured_at DESC, r.id DESC LIMIT ${50}`;
    const plan = await explain(statement.text, statement.values);
    assertIndexed('accessibleSql (raw)', plan, /^media_items_(owner_(user|group)_id|gallery|circle_id|captured_at)_idx$/);
  });

  it('4e. the unordered owner lookups (a count, a membership probe) use the owner / circle indexes', async () => {
    const me = await groups.enrich(principal(users.n));
    captured.length = 0;
    await data.runInOrg({ orgId, userId: users.n }, async (rawTx) => {
      const tx = rawTx as Prisma.TransactionClient;
      await tx.mediaItem.count({
        where: {
          AND: [
            ownedByMeOrMyGroups(me, { ownerUserField: 'ownerUserId', ownerGroupField: 'ownerGroupId' }) as Prisma.MediaItemWhereInput,
            { deletedAt: null },
          ],
        },
      });
    });
    const hit = [...captured].reverse().find((q) => /FROM "public"\."media_items"/.test(q.query) && /COUNT/i.test(q.query));
    if (!hit) throw new Error('no media_items count statement was captured');
    assertIndexed('ownedByMeOrMyGroups count (selective caller)', await explain(hit.query, JSON.parse(hit.params) as unknown[]), /^media_items_owner_(user|group)_id_idx$/);
  });
});

