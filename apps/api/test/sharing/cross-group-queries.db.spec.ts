/**
 * Real-Postgres tier (RETRO-I3, #573): the cross-circle query inventory
 * (docs/platform-adoption/circles-to-groups.md §8) sees exactly the platform
 * groups plus personal content, and grants add records on top.
 *
 * Every sweep of §8 (the admin backfills, the location rebuild, memories generation and digest,
 * the review-queue reconcile, the node backup scope) reads the platform groups
 * (`GroupsService.listForSystem`, `GroupMembershipService.membersForSystem`) and the personal
 * libraries (RETRO-K1, RETRO-K2: `personal_libraries`; there is no `circles` table). This spec
 * proves it on the real schema, as the application role (NOSUPERUSER NOBYPASSRLS):
 *
 *   1. the owner scopes a sweep iterates = the default organization's groups
 *      plus one personal library per user, whose content the user owns;
 *   2. the review-queue reconcile audience (collaborator, circle_admin) = the
 *      group's `editor` and `admin` members; the digest audience = all members;
 *   3. the node backup scope of a user = their group memberships plus their
 *      personal library;
 *   4. a user in two groups sees the union of both groups plus their personal
 *      content (`accessibleWhere`, scope `all`), never a third group's, and a
 *      grant on one record of the third group adds exactly that record;
 *   5. `RecordAccessService` (the media/album grant fallback) decides on the
 *      real grants table: a viewer grant reads, never writes, and only names
 *      its grantee.
 *
 * Skips (reported as skipped) when nothing listens on the configured port.
 */
import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  AccessPolicy,
  GroupMembershipService,
  GroupsService,
  PrincipalGroupsProvider,
  accessibleWhere,
  resolveSharingModuleOptions,
} from '@marinoscar/platform-api/sharing';
import type { UserPrincipal } from '@marinoscar/platform-api/core';
import { Client } from 'pg';

import { createPersonalLibrary, createSharedLibrary, dropLibraries } from '../helpers/library';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../../src/platform/sharing/owner-scope-sweep.service';
import { PersonalLibraryStore } from '../../src/platform/sharing/personal-library.store';
import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { SharingDataAdapter } from '../../src/platform/sharing/sharing-data.adapter';
import { RecordAccessService } from '../../src/platform/sharing/record-access';
import '../../src/app-registrations/sharing';
import { OWNER_SCOPE_SWEEP_REASON } from '../../src/app-registrations/system-access-reasons';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { orgScoped } from '../helpers/org-scope';

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

describeMaybeDb('RETRO-I3 cross-group queries (DB_GATED: real PostgreSQL)', () => {
  // A throwaway role; its secret is random per run, never a fixed literal.
  const role = { name: `i3b_app_${randomUUID().replace(/-/g, '').slice(0, 8)}`, secret: randomUUID() };
  const tag = randomUUID().slice(0, 8);
  const users = { u: randomUUID(), v: randomUUID(), w: randomUUID() };
  const circles = { a: randomUUID(), b: randomUUID(), c: randomUUID(), p: randomUUID() };
  const items: Record<keyof typeof circles, string> = { a: '', b: '', c: '', p: '' };

  let admin: Client;
  let app: PrismaClient;
  let data: SharingDataAdapter;
  let groups: PrincipalGroupsProvider;
  let policy: AccessPolicy;
  let records: RecordAccessService;
  let store: PersonalLibraryStore;
  let directory: OwnerScopeSweepService;
  let access: OwnerAccessService;
  let orgId: string;

  const principal = (userId: string, permissions: string[] = []): UserPrincipal => ({
    kind: 'user',
    userId,
    email: '',
    credential: 'session',
    roles: [],
    permissions,
    activeOrgId: orgId,
  });

  async function insertItem(circleId: string, addedBy: string): Promise<string> {
    const object = randomUUID();
    await orgScoped(admin).query(
      `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id, status)
       VALUES ($1, 'photo.jpg', 1000, 'image/jpeg', $2, now(), $3, 'ready')`,
      [object, `seed/i3b/${object}`, orgId],
    );
    const row = await orgScoped(admin).query(
      `INSERT INTO media_items (storage_object_id, added_by_id, updated_at, type, source, original_filename, circle_id, content_hash)
       VALUES ($1, $2, now(), 'photo', 'web', 'photo.jpg', $3, $4) RETURNING id::text AS id`,
      [object, addedBy, circleId, randomUUID()],
    );
    return row.rows[0].id;
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
    for (const [key, members] of [
      ['a', [[users.u, 'editor'], [users.v, 'admin'], [users.w, 'viewer']]],
      ['b', [[users.u, 'viewer'], [users.v, 'admin']]],
      ['c', [[users.w, 'admin']]],
    ] as const) {
      await createSharedLibrary(admin, {
        id: circles[key],
        name: `Circle ${key.toUpperCase()} ${tag}`,
        createdById: users.v,
        members: members.map(([userId, groupRole]) => ({ userId, role: groupRole })),
      });
    }
    await createPersonalLibrary(admin, { id: circles.p, userId: users.u });
    for (const key of Object.keys(circles) as Array<keyof typeof circles>) {
      items[key] = await insertItem(circles[key], key === 'p' ? users.u : users.v);
    }

    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: url(role), max: 2 }) });
    const options = resolveSharingModuleOptions({
      ...SHARING_MODULE_OPTIONS,
      groups: { ...SHARING_MODULE_OPTIONS.groups, membershipCacheTtlSeconds: 0 },
    });
    data = new SharingDataAdapter(app as never, {} as never);
    groups = new PrincipalGroupsProvider(data, options);
    policy = new AccessPolicy(data, groups);
    records = new RecordAccessService(policy, groups, data, { get: async () => orgId } as never);

    // The scope directory of the sweeps, over the REAL slice services and the personal-library store.
    // The system client: a transaction with the transaction-local bypass (what PrismaSystemService does).
    const systemData = new SharingDataAdapter(app as never, {
      runAsSystem: (_reason: string, fn: (tx: unknown) => Promise<unknown>) =>
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
          return fn(tx);
        }),
    } as never);
    const membership = new GroupMembershipService(systemData, options, {} as never, {} as never);
    const groupsService = new GroupsService(systemData, options, membership, {} as never);
    store = new PersonalLibraryStore(app as never);
    directory = new OwnerScopeSweepService(groupsService, membership, store, app as never, { get: async () => orgId } as never);
    access = new OwnerAccessService(store, groups, { get: async () => orgId } as never);
  }, 120_000);

  afterAll(async () => {
    await app?.$disconnect();
    if (admin) {
      const all = Object.values(circles);
      await orgScoped(admin).query(`DELETE FROM grants WHERE resource_id = ANY($1::uuid[])`, [Object.values(items)]).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM media_items WHERE circle_id = ANY($1::uuid[])`, [all]).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM storage_objects WHERE storage_key LIKE 'seed/i3b/%'`).catch(() => undefined);
      await dropLibraries(admin, all).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]).catch(() => undefined);
      await orgScoped(admin).query(`DROP OWNED BY ${role.name}`).catch(() => undefined);
      await orgScoped(admin).query(`DROP ROLE IF EXISTS ${role.name}`).catch(() => undefined);
      await admin.end();
    }
  });

  it('1. the owner scopes a sweep iterates are the groups plus one personal library per user', async () => {
    // The sweeps' own read (memories generation / digest, reconcile, backfills).
    const swept = new Set((await directory.allScopeIds(OWNER_SCOPE_SWEEP_REASON)));
    for (const id of Object.values(circles)) expect(swept.has(id)).toBe(true);
    const scopes = (await directory.allScopes()).filter((scope) => (Object.values(circles) as string[]).includes(scope.id));
    expect(scopes.filter((scope) => scope.kind === 'group').map((scope) => scope.id).sort()).toEqual([circles.a, circles.b, circles.c].sort());
    expect(scopes.find((scope) => scope.kind === 'personal')).toMatchObject({ id: circles.p, ownerId: users.u });
    // The personal library's content is user-owned: no group behind it.
    const personal = (await orgScoped(admin).query(`SELECT owner_user_id::text AS u, owner_group_id FROM media_items WHERE id = $1`, [items.p])).rows[0];
    expect(personal).toEqual({ u: users.u, owner_group_id: null });
    // A group's content is owned by the group, derived from circle_id by the trigger.
    const group = (await orgScoped(admin).query(`SELECT owner_group_id::text AS g, owner_user_id FROM media_items WHERE id = $1`, [items.a])).rows[0];
    expect(group).toEqual({ g: circles.a, owner_user_id: null });
  });

  it('1b. GroupsService.listForSystem lists exactly the groups, never a personal library', async () => {
    const options = resolveSharingModuleOptions({ ...SHARING_MODULE_OPTIONS });
    const membership = new GroupMembershipService(data, options, {} as never, {} as never);
    const service = new GroupsService(data, options, membership, {} as never);
    const listed = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await service.listForSystem({ reason: OWNER_SCOPE_SWEEP_REASON, orgId, cursor, limit: 500 });
      for (const group of page.items) listed.add(group.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const mine = Object.values({ a: circles.a, b: circles.b, c: circles.c });
    expect(mine.every((id) => listed.has(id))).toBe(true);
    // The personal library is no group.
    expect(listed.has(circles.p)).toBe(false);
  });

  it.each(['a', 'b', 'c'] as const)('2. circle %s: reconcile audience = group editor+admin, digest audience = all members', async (key) => {
    const circleId = circles[key];
    const reconcile = await directory.membersOf(circleId, ['admin', 'editor']);
    const editors = await orgScoped(admin).query(`SELECT user_id::text AS u FROM group_members WHERE group_id = $1 AND role IN ('editor', 'admin')`, [
      circleId,
    ]);
    expect(new Set(reconcile.map((m) => m.userId))).toEqual(new Set(editors.rows.map((r) => r.u)));

    const digest = await directory.membersOf(circleId);
    const everyone = await orgScoped(admin).query(`SELECT user_id::text AS u FROM group_members WHERE group_id = $1`, [circleId]);
    expect(new Set(digest.map((m) => m.userId))).toEqual(new Set(everyone.rows.map((r) => r.u)));
  });

  it('2b. a personal library has one member, its owner, as admin; existence covers both kinds', async () => {
    await expect(directory.membersOf(circles.p)).resolves.toEqual([{ userId: users.u, role: 'admin' }]);
    await expect(directory.membersOf(circles.p, ['editor'])).resolves.toEqual([]);
    await expect(directory.exists(circles.p)).resolves.toBe(true);
    await expect(directory.exists(circles.a)).resolves.toBe(true);
    await expect(directory.exists(randomUUID())).resolves.toBe(false);
  });

  it("3. a user's node backup scope = their group memberships plus their personal library", async () => {
    const scope = await access.scopesOf(users.u);
    const memberOf = (await groups.groupsFor(principal(users.u))).map((g) => g.groupId);
    expect(new Set(scope)).toEqual(new Set([...memberOf, circles.p]));
    expect(new Set(memberOf)).toEqual(new Set([circles.a, circles.b]));
  });

  async function visibleItems(userId: string): Promise<Set<string>> {
    const me = await groups.enrich(principal(userId));
    const ids = await data.runInOrg({ orgId, userId }, async (rawTx) => {
      const tx = rawTx as Prisma.TransactionClient;
      const access = await accessibleWhere(me, 'media_item', { tx, sqlKit: Prisma, scope: 'all' });
      if (access.form !== 'where') throw new Error('unexpected EXISTS form');
      const rows = await tx.mediaItem.findMany({
        where: { AND: [access.where as Prisma.MediaItemWhereInput, { id: { in: Object.values(items) } }] },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    });
    return new Set(ids);
  }

  it('4. a user in two groups sees both groups plus personal content, never a third group; a grant adds one record', async () => {
    expect(await visibleItems(users.u)).toEqual(new Set([items.a, items.b, items.p]));
    expect(await visibleItems(users.w)).toEqual(new Set([items.a, items.c]));

    await orgScoped(admin).query(
      `INSERT INTO grants (id, org_id, resource_type, resource_id, grantee_kind, grantee_user_id, role, granted_by_id, updated_at)
       VALUES ($1, $2, 'media_item', $3, 'user', $4, 'viewer', $5, now())`,
      [randomUUID(), orgId, items.c, users.u, users.w],
    );
    expect(await visibleItems(users.u)).toEqual(new Set([items.a, items.b, items.c, items.p]));
    // The grant names its grantee only: V (admin of A and B, creator of circle C but not
    // a member of its group) still does not see C's item.
    expect(await visibleItems(users.v)).toEqual(new Set([items.a, items.b]));
  });

  it('5. the media grant fallback decides on the real grants table', async () => {
    // (the viewer grant on item C inserted by case 4)
    await expect(records.grantAllows(users.u, [], 'read', 'media_item', items.c)).resolves.toBe(true);
    await expect(records.grantAllows(users.u, ['media:write'], 'write', 'media_item', items.c)).resolves.toBe(false);
    await expect(records.grantAllows(users.u, [], 'read', 'media_item', items.a)).resolves.toBe(false); // group owner, not a grant
    await expect(records.grantsAllowAll(users.u, [], 'read', 'media_item', [items.c, items.b])).resolves.toBe(false);
    await expect(records.grantsAllowAll(users.u, [], 'read', 'media_item', [items.c])).resolves.toBe(true);
    const shared = await records.sharedWhere(users.u, [], 'media_item');
    expect(JSON.stringify(shared)).toContain(items.c);
    expect(JSON.stringify(shared)).not.toContain(items.a);
    await expect(records.sharedWhere(users.v, [], 'media_item')).resolves.toBeNull();
  });
});
