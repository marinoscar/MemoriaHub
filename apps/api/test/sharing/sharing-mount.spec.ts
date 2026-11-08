/**
 * The platform sharing slice is mounted (RETRO-I1, #562).
 *
 * Boots the whole AppModule against the mocked Prisma client and checks the
 * acceptance criteria that do not need a real database:
 *   - `GET /api/groups?scope=mine` answers 200 with an empty list for a caller
 *     holding `groups:read` (no circle has been mapped to a group yet: RETRO-I2),
 *     and 403 without it;
 *   - `GET /api/grants` requires `sharing:read`;
 *   - `GET /api/public/links/current` is mounted (the host has `allowPublic`) and
 *     answers the one 404 without a token, with the public-response headers;
 *   - `sharing.grants.prune` is a registered, server-only job type;
 *   - `groups.invitation` and `sharing.shared_with_you` are registered
 *     notification events bound to MemoriaHub-layout e-mail templates;
 *   - the slice runs in single-organization mode with the #562 options.
 *
 * The real-database tier is not needed here: RETRO-I1 writes no data.
 */

import request from 'supertest';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import { emailTemplateRegistry, notificationEventRegistry } from '@marinoscar/platform-api/notifications';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import {
  GRANTS_PRUNE_JOB_TYPE,
  SHARING_OPTIONS,
  SHARING_TENANCY,
  type ResolvedSharingModuleOptions,
  type SharingTenancy,
} from '@marinoscar/platform-api/sharing';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';
import { sharingControllers } from '../../src/platform/sharing/sharing.config';

describe('platform sharing slice mount (RETRO-I1)', () => {
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
    mockPrismaTransaction();
    (context.module.get(SystemSettingsService) as any).settingsCache = null;
  });

  /** Adds permission names to one user's role graph (the shared fixture lists none of these). */
  function grant(userId: string, names: string[]): void {
    const base = (context.prismaMock.user.findUnique as jest.Mock).getMockImplementation();
    (context.prismaMock.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      const result = base ? await base(args) : null;
      if (!result || result.id !== userId) return result;
      return {
        ...result,
        userRoles: result.userRoles.map((ur: any) => ({
          ...ur,
          role: {
            ...ur.role,
            rolePermissions: [
              ...ur.role.rolePermissions,
              ...names.map((name) => ({ permission: { id: `perm-${name}`, name } })),
            ],
          },
        })),
      };
    });
  }

  it('GET /api/groups?scope=mine answers an empty list to a caller holding groups:read', async () => {
    const viewer = await createMockViewerUser(context);
    grant(viewer.id, ['groups:read']);
    (context.prismaMock.group.count as jest.Mock).mockResolvedValue(0);
    (context.prismaMock.group.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(context.app.getHttpServer())
      .get('/api/groups?scope=mine')
      .set(authHeader(viewer.accessToken));

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body.data) ? res.body.data : res.body.data.items;
    expect(items).toEqual([]);
  });

  it('GET /api/groups refuses a caller without groups:read', async () => {
    const viewer = await createMockViewerUser(context);
    const res = await request(context.app.getHttpServer())
      .get('/api/groups?scope=mine')
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(403);
  });

  it('GET /api/grants requires sharing:read', async () => {
    const viewer = await createMockViewerUser(context);
    const res = await request(context.app.getHttpServer())
      .get('/api/grants?resourceType=media_item&resourceId=00000000-0000-4000-8000-000000000001')
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(403);
  });

  it('mounts the public link route: the one 404 without a token, with the public headers', async () => {
    expect(Object.keys(sharingControllers).some((name) => /public/i.test(name))).toBe(true);

    const res = await request(context.app.getHttpServer()).get('/api/public/links/current');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('registers sharing.grants.prune as a server-only job type', () => {
    const registry = context.module.get(JobHandlerRegistry);
    expect(registry.types()).toContain(GRANTS_PRUNE_JOB_TYPE);
    expect(registry.serverOnlyTypes()).toContain(GRANTS_PRUNE_JOB_TYPE);
  });

  it('registers the two sharing notification events, bound to their e-mail templates', () => {
    for (const key of ['groups.invitation', 'sharing.shared_with_you']) {
      expect(notificationEventRegistry.has(key)).toBe(true);
    }
    expect(emailTemplateRegistry.has('group-invitation')).toBe(true);
    expect(emailTemplateRegistry.has('shared-with-you')).toBe(true);
  });

  it('runs in single-organization mode with the #562 options', () => {
    const tenancy = context.module.get<SharingTenancy>(SHARING_TENANCY, { strict: false });
    expect(tenancy.mode()).toBe('single');

    const options = context.module.get<ResolvedSharingModuleOptions>(SHARING_OPTIONS, { strict: false });
    expect(options.groups.inviteTtlDays).toBeNull();
    expect(options.groups.autoAcceptInvitesOnSignup).toBe(false);
    expect(options.links.defaultTtlDays).toBeNull();
    expect(options.links.maxTtlDays).toBeNull();
  });
});
