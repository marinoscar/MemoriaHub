/**
 * Real-Postgres tier (RETRO-I3, #573): owner-scope access decided by platform
 * group membership, end to end.
 *
 *   - circles and their members written the way the app writes them are
 *     mirrored into `groups` / `group_members` by the RETRO-I2 triggers, and
 *     `OwnerAccessService` reads the caller's role from there through the
 *     sharing slice's `PrincipalGroupsProvider` and the app's
 *     `SharingDataAdapter` (transaction-local `app.org_id`, forced RLS);
 *   - the per-circle rules are unchanged (admin / editor / viewer ranks, the
 *     personal library's owner) and a non-member, or anyone on someone else's
 *     personal library, gets 404;
 *   - a role change or a removal is seen on the next check (membership cache
 *     off here; production invalidates it on every circle membership write);
 *   - row-level security matters: the same lookup run as the application role
 *     in ANOTHER organization's scope finds no membership at all.
 *
 * Runs as a NOSUPERUSER NOBYPASSRLS role (a superuser would bypass RLS).
 * Skips (reported as skipped) when nothing listens on the configured port.
 */
import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PrincipalGroupsProvider, resolveSharingModuleOptions } from '@marinoscar/platform-api/sharing';
import { Client } from 'pg';

import { PersonalLibraryStore } from '../../src/platform/sharing/personal-library.store';
import { createPersonalLibrary, createSharedLibrary, dropLibraries } from '../helpers/library';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { SharingDataAdapter } from '../../src/platform/sharing/sharing-data.adapter';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

function connection(user?: { name: string; password: string }) {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: user?.name ?? (process.env.POSTGRES_USER || 'postgres'),
    password: user?.password ?? (process.env.POSTGRES_PASSWORD || 'postgres'),
    database: process.env.POSTGRES_DB || 'appdb',
  };
}

function url(user?: { name: string; password: string }): string {
  const c = connection(user);
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`;
}

describeMaybeDb('RETRO-I3 owner-scope access on platform groups (DB_GATED: real PostgreSQL)', () => {
  const role = { name: `i3_app_${randomUUID().replace(/-/g, '').slice(0, 8)}`, password: 'i3-test-password' };
  const tag = randomUUID().slice(0, 8);
  let admin: Client;
  let appPrisma: PrismaClient;
  let service: OwnerAccessService;
  let groups: PrincipalGroupsProvider;
  let orgId: string;
  const users: Record<'owner' | 'editor' | 'viewer' | 'stranger', string> = {
    owner: randomUUID(),
    editor: randomUUID(),
    viewer: randomUUID(),
    stranger: randomUUID(),
  };
  const shared = randomUUID();
  const personal = randomUUID();

  beforeAll(async () => {
    admin = new Client(connection());
    await admin.connect();
    orgId = (await admin.query(`SELECT id::text AS id FROM organizations WHERE is_default`)).rows[0].id;

    await admin.query(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role.name}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role.name}`);

    for (const [key, id] of Object.entries(users)) {
      await admin.query(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [id, `${key}-${tag}@example.test`]);
    }
    // A shared library is a group; a personal library is a `personal_libraries` row (RETRO-K2).
    await createSharedLibrary(admin, {
      id: shared,
      createdById: users.owner,
      members: [
        { userId: users.owner, role: 'admin' },
        { userId: users.editor, role: 'editor' },
        { userId: users.viewer, role: 'viewer' },
      ],
    });
    await createPersonalLibrary(admin, { id: personal, userId: users.owner });

    appPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url(role), max: 2 }) });
    const options = resolveSharingModuleOptions({
      ...SHARING_MODULE_OPTIONS,
      groups: { ...SHARING_MODULE_OPTIONS.groups, membershipCacheTtlSeconds: 0 },
    });
    groups = new PrincipalGroupsProvider(new SharingDataAdapter(appPrisma as never, {} as never), options);
    service = new OwnerAccessService(new PersonalLibraryStore(appPrisma as never), groups, { get: async () => orgId } as never);
  }, 120_000);

  afterAll(async () => {
    await appPrisma?.$disconnect();
    if (admin) {
      await dropLibraries(admin, [shared, personal]).catch(() => undefined);
      await admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]).catch(() => undefined);
      await admin.query(`DROP OWNED BY ${role.name}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role.name}`).catch(() => undefined);
      await admin.end();
    }
  });

  it('the shared circle is a group with its member roles', async () => {
    const rows = (
      await admin.query(`SELECT user_id::text AS u, role FROM group_members WHERE group_id = $1 ORDER BY role`, [shared])
    ).rows;
    expect(Object.fromEntries(rows.map((r) => [r.u, r.role]))).toEqual({
      [users.owner]: 'admin',
      [users.editor]: 'editor',
      [users.viewer]: 'viewer',
    });
  });

  it.each([
    ['owner', 'admin', 'admin'],
    ['editor', 'editor', 'editor'],
    ['viewer', 'viewer', 'viewer'],
  ] as const)('%s passes %s on the shared circle with role %s', async (who, min, held) => {
    await expect(service.requireOwnerRole(users[who], shared, [], min)).resolves.toEqual({ role: held, isSuperAdmin: false });
  });

  it.each([
    ['viewer', 'editor'],
    ['viewer', 'admin'],
    ['editor', 'admin'],
  ] as const)('%s below %s gets 403 (membership is not a secret to a member)', async (who, min) => {
    await expect(service.requireOwnerRole(users[who], shared, [], min)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a non-member gets 404 (was 403)', async () => {
    await expect(service.requireOwnerRole(users.stranger, shared, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the personal library: its owner is admin, anyone else (even a co-member of a shared circle) 404", async () => {
    await expect(service.requireOwnerRole(users.owner, personal, [], 'admin')).resolves.toEqual({ role: 'admin', isSuperAdmin: false });
    await expect(service.requireOwnerRole(users.editor, personal, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a role change and a removal in group_members are seen on the next check', async () => {
    await admin.query(`UPDATE group_members SET role = 'editor' WHERE group_id = $1 AND user_id = $2`, [shared, users.viewer]);
    await expect(service.roleIn(users.viewer, shared)).resolves.toBe('editor');
    await admin.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [shared, users.viewer]);
    await expect(service.requireOwnerRole(users.viewer, shared, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('row-level security: the same lookup scoped to another organization finds no membership', async () => {
    const otherOrg = randomUUID();
    const memberships = await groups.groupsFor({
      kind: 'user',
      userId: users.owner,
      email: '',
      credential: 'session',
      roles: [],
      permissions: [],
      activeOrgId: otherOrg,
    });
    expect(memberships).toEqual([]);
    const own = await groups.groupsFor({
      kind: 'user',
      userId: users.owner,
      email: '',
      credential: 'session',
      roles: [],
      permissions: [],
      activeOrgId: orgId,
    });
    expect(own.map((g) => g.groupId)).toContain(shared);
  });
});
