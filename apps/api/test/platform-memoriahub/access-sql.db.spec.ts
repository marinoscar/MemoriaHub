// =============================================================================
// The access port's conformance rules over real PostgreSQL, with the sharedWhere and owner-scope list rules
// run as SQL (RETRO-J4, #610; retro-gaps audit)
// =============================================================================
//
// `ports-conformance.spec.ts` runs the access rules against stand-ins for the memberships and the grants, so the
// `sharedWhere` fragment was never applied to a query. Here the REAL slice services (`OwnerAccessService`,
// `RecordAccessService`, `OwnerScopeSweepService`, `AccessPolicy`) sit under the web edition's
// `PlatformMemoriahubAccessAdapter` on the real `groups`, `group_members`, `personal_libraries`, `grants` and
// `media_items` tables, as the application role (NOSUPERUSER NOBYPASSRLS, so row-level security applies), and
// the fragment the adapter answers is run as the `where` of a real `media_items` query:
//
//   - the shared fragment selects exactly the granted record;
//   - a member's list is their scopes' records, a grantee's only the granted one, an outsider's none;
//   - a read grant yields no fragment for write access, a user with no grants yields none.
//
// DB_GATED: reported as skipped (never passed) when no database is reachable.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  AccessPolicy,
  GroupMembershipService,
  GroupsService,
  PrincipalGroupsProvider,
  resolveSharingModuleOptions,
} from '@marinoscar/platform-api/sharing';
import { describeMemoriahubPortsConformance, type MemoriahubPortsUnderTest } from '@marinoscar/memoriahub-api/testing';
import { Client } from 'pg';

import '../../src/app-registrations/sharing';
import { PlatformMemoriahubAccessAdapter } from '../../src/platform-memoriahub/access/platform-memoriahub-access.adapter';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../../src/platform/sharing/owner-scope-sweep.service';
import { PersonalLibraryStore } from '../../src/platform/sharing/personal-library.store';
import { RecordAccessService } from '../../src/platform/sharing/record-access';
import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { SharingDataAdapter } from '../../src/platform/sharing/sharing-data.adapter';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { createSharedLibrary, dropLibraries } from '../helpers/library';
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

const url = (user: { name: string; secret: string }): string => {
  const c = connection(user);
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`;
};

describeMaybeDb('access port over real PostgreSQL (DB_GATED)', () => {
  // A throwaway role; its secret is random per run, never a fixed literal.
  const role = { name: `acc_app_${randomUUID().replace(/-/g, '').slice(0, 8)}`, secret: randomUUID() };
  const tag = randomUUID().slice(0, 8);
  const u = {
    viewer: randomUUID(), editor: randomUUID(), admin: randomUUID(), outsider: randomUUID(), grantee: randomUUID(),
  };
  const scopeA = randomUUID(); // viewer/editor/admin members
  const scopeB = randomUUID(); // the admin's second group: holds the granted and the ungranted record
  const items = { inScope: '', granted: '', other: '' };

  let admin: Client;
  let app: PrismaClient;
  let orgId: string;
  let adapter: PlatformMemoriahubAccessAdapter;

  async function insertItem(circleId: string, addedBy: string): Promise<string> {
    const object = randomUUID();
    await orgScoped(admin).query(
      `INSERT INTO storage_objects (id, name, size, mime_type, storage_key, updated_at, org_id, status)
       VALUES ($1, 'photo.jpg', 1000, 'image/jpeg', $2, now(), $3, 'ready')`,
      [object, `seed/access-sql/${object}`, orgId],
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

    for (const [key, id] of Object.entries(u)) {
      await orgScoped(admin).query(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [id, `${key}-${tag}@example.test`]);
    }
    await createSharedLibrary(admin, {
      id: scopeA, name: `Library A ${tag}`, createdById: u.admin,
      members: [{ userId: u.admin, role: 'admin' }, { userId: u.editor, role: 'editor' }, { userId: u.viewer, role: 'viewer' }],
    });
    await createSharedLibrary(admin, { id: scopeB, name: `Library B ${tag}`, createdById: u.admin, members: [{ userId: u.admin, role: 'admin' }] });
    items.inScope = await insertItem(scopeA, u.admin);
    items.granted = await insertItem(scopeB, u.admin);
    items.other = await insertItem(scopeB, u.admin);
    await orgScoped(admin).query(
      `INSERT INTO grants (id, org_id, resource_type, resource_id, grantee_kind, grantee_user_id, role, granted_by_id, updated_at)
       VALUES ($1, $2, 'media_item', $3, 'user', $4, 'viewer', $5, now())`,
      [randomUUID(), orgId, items.granted, u.grantee, u.admin],
    );

    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: url(role), max: 2 }) });
    const options = resolveSharingModuleOptions({
      ...SHARING_MODULE_OPTIONS,
      groups: { ...SHARING_MODULE_OPTIONS.groups, membershipCacheTtlSeconds: 0 },
    });
    const data = new SharingDataAdapter(app as never, {} as never);
    const groups = new PrincipalGroupsProvider(data, options);
    const policy = new AccessPolicy(data, groups);
    const defaultOrg = { get: async () => orgId } as never;
    const records = new RecordAccessService(policy, groups, data, defaultOrg);
    const systemData = new SharingDataAdapter(app as never, {
      runAsSystem: (_reason: string, fn: (tx: unknown) => Promise<unknown>) =>
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
          return fn(tx);
        }),
    } as never);
    const membership = new GroupMembershipService(systemData, options, {} as never, {} as never);
    const groupsService = new GroupsService(systemData, options, membership, {} as never);
    const store = new PersonalLibraryStore(app as never);
    const directory = new OwnerScopeSweepService(groupsService, membership, store, app as never, defaultOrg);
    const owner = new OwnerAccessService(store, groups, defaultOrg);
    adapter = new PlatformMemoriahubAccessAdapter(owner, records, directory);
  }, 120_000);

  afterAll(async () => {
    await app?.$disconnect();
    if (admin) {
      const scopes = [scopeA, scopeB];
      await orgScoped(admin).query(`DELETE FROM grants WHERE resource_id = ANY($1::uuid[])`, [Object.values(items)]).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM media_items WHERE circle_id = ANY($1::uuid[])`, [scopes]).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM storage_objects WHERE storage_key LIKE 'seed/access-sql/%'`).catch(() => undefined);
      await dropLibraries(admin, scopes).catch(() => undefined);
      await orgScoped(admin).query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(u)]).catch(() => undefined);
      await orgScoped(admin).query(`DROP OWNED BY ${role.name}`).catch(() => undefined);
      await orgScoped(admin).query(`DROP ROLE IF EXISTS ${role.name}`).catch(() => undefined);
      await admin.end();
    }
  });

  /** A list over the owner scopes and the shared fragment, as the services build one: the fragment is ANDed in, never spread. */
  async function matching({ scopeIds, shared }: { scopeIds: readonly string[]; shared: Record<string, unknown> | null }): Promise<string[]> {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
      return tx.mediaItem.findMany({
        where: {
          id: { in: Object.values(items) },
          OR: [{ circleId: { in: [...scopeIds] } }, ...(shared ? [shared] : [])],
        } as never,
        select: { id: true },
      });
    });
    return rows.map((row) => row.id).sort();
  }

  const underTest = (): MemoriahubPortsUnderTest => ({
    access: {
      port: adapter,
      scope: {
        scopeId: scopeA,
        viewerId: u.viewer,
        editorId: u.editor,
        adminId: u.admin,
        outsiderId: u.outsider,
        unknownScopeId: randomUUID(),
        bypassPermission: 'groups:admin',
      },
      grants: {
        granteeId: u.grantee,
        mediaItemId: items.granted,
        otherMediaItemId: items.other,
        scopeItemId: items.inScope,
        matching,
      },
    },
  });

  describeMemoriahubPortsConformance(
    'the web edition access adapter over real PostgreSQL',
    underTest,
    { describe, it, expect },
    {
      sharedWhereSql: true,
      skip: ['jobs', 'ai', 'objectStore', 'identity', 'notify', 'events', 'settings', 'secrets', 'audit', 'webhooks', 'metrics'],
    },
  );
});
