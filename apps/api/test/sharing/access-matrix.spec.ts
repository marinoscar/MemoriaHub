/**
 * RETRO-I3 (#573): the owner-scope access matrix.
 *
 * Proves that moving circle access onto platform group membership
 * (`OwnerAccessService` over the sharing slice's `PrincipalGroupsProvider`) is
 * EXACTLY the former per-circle rules (`CircleMembershipService`), except the
 * one deliberate change: a non-member gets 404 instead of 403 (enumeration
 * resistance, docs/platform-adoption/circles-to-groups.md §6).
 *
 * Two layers:
 *   1. The decision itself: the real `OwnerAccessService` and the real
 *      `PrincipalGroupsProvider` over an in-memory `group_members`, for every
 *      {required role} x {caller: admin, editor, viewer, non-member, personal
 *      owner, stranger on a personal scope, unknown scope, bypass permission}.
 *   2. Representative routes per domain through the real app (mocked Prisma,
 *      group membership mirrored from the circle mocks as the RETRO-I2 trigger
 *      mirrors it): every {viewer, collaborator, circle_admin, non-member,
 *      system admin} x route, against the legacy expectation computed from the
 *      old rule table.
 */
import request from 'supertest';
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  PrincipalGroupsProvider,
  resolveSharingModuleOptions,
  type SharingDataPort,
} from '@marinoscar/platform-api/sharing';

import { OwnerAccessService, type OwnerRole } from '../../src/platform/sharing/owner-scope';
import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { createTestApp, closeTestApp, TestContext } from '../helpers/test-app.helper';
import { createMockAdminUser, createMockContributorUser, authHeader } from '../helpers/auth-mock.helper';
import { resetPrismaMock, prismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

type LegacyRole = 'viewer' | 'collaborator' | 'circle_admin';
const LEGACY_RANK: Record<LegacyRole, number> = { viewer: 1, collaborator: 2, circle_admin: 3 };
const TO_GROUP: Record<LegacyRole, OwnerRole> = { viewer: 'viewer', collaborator: 'editor', circle_admin: 'admin' };

/** The former `CircleMembershipService.assertCircleAccess` outcome. */
function legacyOutcome(held: LegacyRole | null, required: LegacyRole, bypass: boolean): 'allow' | 403 {
  if (bypass) return 'allow';
  if (held === null) return 403;
  return LEGACY_RANK[held] < LEGACY_RANK[required] ? 403 : 'allow';
}

/** The RETRO-I3 outcome: the legacy one, with a non-member's 403 turned into 404. */
function expectedOutcome(held: LegacyRole | null, required: LegacyRole, bypass: boolean): 'allow' | 403 | 404 {
  const legacy = legacyOutcome(held, required, bypass);
  if (legacy === 403 && held === null) return 404;
  return legacy;
}

// ---------------------------------------------------------------------------
// 1. The decision
// ---------------------------------------------------------------------------

describe('OwnerAccessService decision matrix (RETRO-I3)', () => {
  const ORG = '00000000-0000-4000-8000-0000000000d0';
  const GROUP = randomUUID();
  const PERSONAL = randomUUID();
  const OWNER = randomUUID();
  const STRANGER = randomUUID();
  const members = new Map<string, LegacyRole>();

  let circles: Record<string, { id: string; isPersonal: boolean; ownerId: string }>;
  let service: OwnerAccessService;
  let lookups: number;

  beforeEach(() => {
    members.clear();
    lookups = 0;
    circles = {
      [GROUP]: { id: GROUP, isPersonal: false, ownerId: OWNER },
      [PERSONAL]: { id: PERSONAL, isPersonal: true, ownerId: OWNER },
    };
    const data: SharingDataPort = {
      runInOrg: async (_scope, fn) =>
        fn({
          groupMember: {
            findMany: async ({ where }: { where: { userId: string } }) => {
              lookups += 1;
              const role = members.get(where.userId);
              return role ? [{ groupId: GROUP, role: TO_GROUP[role] }] : [];
            },
          },
        }),
      runAsSystem: async () => {
        throw new Error('not used');
      },
    };
    const options = resolveSharingModuleOptions({
      ...SHARING_MODULE_OPTIONS,
      groups: { ...SHARING_MODULE_OPTIONS.groups, membershipCacheTtlSeconds: 0 },
    });
    const prisma = {
      circle: { findUnique: async ({ where }: { where: { id: string } }) => circles[where.id] ?? null },
    };
    service = new OwnerAccessService(
      prisma as never,
      new PrincipalGroupsProvider(data, options),
      { get: async () => ORG } as never,
    );
  });

  const held: Array<LegacyRole | null> = ['circle_admin', 'collaborator', 'viewer', null];
  const required: LegacyRole[] = ['viewer', 'collaborator', 'circle_admin'];

  for (const h of held) {
    for (const r of required) {
      const expected = expectedOutcome(h, r, false);
      it(`group scope: ${h ?? 'non-member'} needing ${r} -> ${expected}`, async () => {
        const user = randomUUID();
        if (h) members.set(user, h);
        const attempt = service.requireOwnerRole(user, GROUP, [], TO_GROUP[r]);
        if (expected === 'allow') {
          await expect(attempt).resolves.toEqual({ role: TO_GROUP[h!], isSuperAdmin: false });
        } else if (expected === 404) {
          await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
        } else {
          await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
        }
      });
    }
  }

  it('a non-member and an unknown scope get the SAME 404 body (no probing)', async () => {
    const unknown = randomUUID();
    const a = await service.requireOwnerRole(STRANGER, GROUP, [], 'viewer').catch((e) => e);
    const b = await service.requireOwnerRole(STRANGER, unknown, [], 'viewer').catch((e) => e);
    expect(a).toBeInstanceOf(NotFoundException);
    expect(b).toBeInstanceOf(NotFoundException);
    expect(a.getResponse().message.replace(GROUP, 'X')).toBe(b.getResponse().message.replace(unknown, 'X'));
  });

  it.each(required)('personal scope: the owner passes %s as admin', async (r) => {
    await expect(service.requireOwnerRole(OWNER, PERSONAL, [], TO_GROUP[r])).resolves.toEqual({
      role: 'admin',
      isSuperAdmin: false,
    });
  });

  it('personal scope: anyone else gets 404 (was 403)', async () => {
    await expect(service.requireOwnerRole(STRANGER, PERSONAL, [], 'viewer')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['groups:admin', 'circles:manage_any', 'media:read_any', 'media:write_any'])(
    'bypass permission %s passes any scope, even an unknown one, without being a member',
    async (permission) => {
      await expect(service.requireOwnerRole(STRANGER, GROUP, [permission], 'admin')).resolves.toEqual({
        role: null,
        isSuperAdmin: true,
      });
      await expect(service.requireOwnerRole(STRANGER, randomUUID(), [permission], 'admin')).resolves.toEqual({
        role: null,
        isSuperAdmin: true,
      });
    },
  );

  it('media:delete_any alone is NOT a bypass (unchanged)', async () => {
    await expect(service.requireOwnerRole(STRANGER, GROUP, ['media:delete_any'], 'viewer')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reads the role from group membership, so a membership change is seen without a restart (cache off)', async () => {
    const user = randomUUID();
    await expect(service.roleIn(user, GROUP)).resolves.toBeNull();
    members.set(user, 'collaborator');
    await expect(service.roleIn(user, GROUP)).resolves.toBe('editor');
    expect(lookups).toBe(2);
  });

  it('a personal scope never consults group membership', async () => {
    await service.requireOwnerRole(OWNER, PERSONAL, [], 'admin');
    expect(lookups).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Representative routes per domain
// ---------------------------------------------------------------------------

const CIRCLE_ID = '6f3a8a2e-1111-4a6b-9c1d-000000000001';
const SOME_ID = '6f3a8a2e-2222-4a6b-9c1d-000000000002';

interface RouteCase {
  domain: string;
  method: 'get' | 'post' | 'patch';
  path: string;
  body?: Record<string, unknown>;
  required: LegacyRole;
}

const ROUTES: RouteCase[] = [
  { domain: 'media', method: 'get', path: `/api/media?circleId=${CIRCLE_ID}`, required: 'viewer' },
  { domain: 'media', method: 'get', path: `/api/media/trash?circleId=${CIRCLE_ID}`, required: 'viewer' },
  {
    domain: 'media',
    method: 'patch',
    path: '/api/media/bulk/archive',
    body: { circleId: CIRCLE_ID, ids: [SOME_ID] },
    required: 'collaborator',
  },
  { domain: 'media', method: 'post', path: '/api/media/trash/empty', body: { circleId: CIRCLE_ID }, required: 'circle_admin' },
  { domain: 'albums', method: 'get', path: `/api/media/albums?circleId=${CIRCLE_ID}`, required: 'viewer' },
  {
    domain: 'albums',
    method: 'post',
    path: '/api/media/albums',
    body: { circleId: CIRCLE_ID, name: 'Album A' },
    required: 'collaborator',
  },
  { domain: 'bursts', method: 'get', path: `/api/media/bursts?circleId=${CIRCLE_ID}`, required: 'viewer' },
  { domain: 'duplicates', method: 'get', path: `/api/media/duplicates?circleId=${CIRCLE_ID}`, required: 'viewer' },
  { domain: 'review', method: 'get', path: `/api/media/review-insights?circleId=${CIRCLE_ID}`, required: 'viewer' },
  {
    domain: 'location',
    method: 'get',
    path: `/api/media/location-suggestions?circleId=${CIRCLE_ID}`,
    required: 'viewer',
  },
  { domain: 'enhancement', method: 'get', path: `/api/media/enhancements?circleId=${CIRCLE_ID}`, required: 'viewer' },
  { domain: 'people', method: 'get', path: `/api/people?circleId=${CIRCLE_ID}`, required: 'viewer' },
  { domain: 'people', method: 'post', path: '/api/people', body: { circleId: CIRCLE_ID, name: 'Person A' }, required: 'collaborator' },
  { domain: 'search', method: 'post', path: '/api/search', body: { circleId: CIRCLE_ID }, required: 'viewer' },
  { domain: 'circles', method: 'get', path: `/api/circles/${CIRCLE_ID}`, required: 'viewer' },
  { domain: 'circles', method: 'patch', path: `/api/circles/${CIRCLE_ID}`, body: { name: 'Renamed' }, required: 'circle_admin' },
];

/**
 * The mock role fixtures predate `circles:*` and `search:use`; grant them on
 * the registered mock user so the RBAC layer admits the call and the matrix
 * measures the owner-scope gate alone (the catalog grants both to every role).
 */
async function grantPermissions(userId: string, names: string[]): Promise<void> {
  const graph = await prismaMock.user.findUnique({ where: { id: userId } });
  const role = graph.userRoles[0].role;
  for (const name of names) {
    role.rolePermissions.push({ roleId: role.id, permissionId: randomUUID(), permission: { id: randomUUID(), name, description: null } });
  }
}

type Caller = { label: string; held: LegacyRole | null; admin: boolean };
const CALLERS: Caller[] = [
  { label: 'circle_admin (group admin)', held: 'circle_admin', admin: false },
  { label: 'collaborator (group editor)', held: 'collaborator', admin: false },
  { label: 'viewer (group viewer)', held: 'viewer', admin: false },
  { label: 'non-member', held: null, admin: false },
  { label: 'system admin (bypass, not a member)', held: null, admin: true },
];

describe('Owner-scope access matrix over representative routes (RETRO-I3)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
  });

  for (const route of ROUTES) {
    for (const caller of CALLERS) {
      const expected = expectedOutcome(caller.held, route.required, caller.admin);
      it(`${route.domain}: ${route.method.toUpperCase()} ${route.path.split('?')[0]} (needs ${route.required}) as ${caller.label} -> ${expected}`, async () => {
        const user = caller.admin ? await createMockAdminUser(context) : await createMockContributorUser(context);
        await grantPermissions(user.id, ['circles:read', 'circles:write', 'search:use']);
        const m = context.prismaMock;
        m.circle.findUnique.mockResolvedValue({ id: CIRCLE_ID, isPersonal: false, ownerId: randomUUID(), name: 'Circle A' });
        m.circleMember.findUnique.mockResolvedValue(
          caller.held ? { circleId: CIRCLE_ID, userId: user.id, role: caller.held, joinedAt: new Date() } : null,
        );

        let req = request(context.app.getHttpServer())[route.method](route.path).set(authHeader(user.accessToken));
        if (route.body) req = req.send(route.body);
        const res = await req;

        if (expected === 'allow') {
          // The owner-scope gate passed: whatever the handler does next with the
          // mocked data, it is never an access refusal.
          expect([401, 403, 404]).not.toContain(res.status);
        } else {
          expect(res.status).toBe(expected);
        }
      });
    }
  }
});
