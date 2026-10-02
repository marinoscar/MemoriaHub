// =============================================================================
// Integration tests for the Android app trust routes (issue #503, epic #498)
// =============================================================================
//
//   GET /api/admin/android-app                system_settings:read
//   PUT /api/admin/android-app                system_settings:write
//   GET /api/well-known/assetlinks.json       public, bare JSON, maintenance-exempt
//
// Through the real AppModule, guard stack, pipes, response interceptor and
// exception filter: RBAC in both directions, the envelope on the admin routes
// and its ABSENCE on the public one (Chrome needs a bare array), the headers,
// `details.reason` on a validation 400, and the row and audit event a save
// writes.
// =============================================================================

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import { AndroidAppController } from '../../src/android-app/android-app.controller';
import { AssetLinksController } from '../../src/android-app/asset-links.controller';
import {
  ANDROID_APP_SETTINGS_KEY,
  ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
} from '../../src/android-app/android-app.schema';
import { ALLOW_DURING_MAINTENANCE_KEY } from '../../src/common/maintenance/allow-during-maintenance.decorator';
import { MaintenanceModeService } from '../../src/common/maintenance/maintenance-mode.service';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const ADMIN_ROUTE = '/api/admin/android-app';
const ASSET_LINKS_ROUTE = '/api/well-known/assetlinks.json';
const PACKAGE = 'memoriahub.marin.cr';

const SHA_A = Array.from({ length: 32 }, () => 'AB').join(':');
const SHA_B = Array.from({ length: 32 }, () => 'CD').join(':');

describe('Android app trust API (Integration)', () => {
  let context: TestContext;
  let stored: unknown;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    stored = undefined;

    const prisma = context.prismaMock;
    const baseFindUnique = prisma.systemSettings.findUnique.getMockImplementation();
    prisma.systemSettings.findUnique.mockImplementation(async (args: { where: { key: string } }) => {
      if (args.where.key === ANDROID_APP_SETTINGS_KEY) {
        return stored === undefined ? null : { key: ANDROID_APP_SETTINGS_KEY, value: stored, version: 1 };
      }
      return baseFindUnique ? baseFindUnique(args) : null;
    });
    prisma.systemSettings.upsert.mockImplementation(
      async (args: { where: { key: string }; create: { value: unknown } }) => {
        stored = args.create.value;
        return { key: args.where.key, value: args.create.value, version: 1 };
      },
    );
    prisma.mediaSyncDevice.groupBy.mockResolvedValue([]);
  });

  const server = () => context.app.getHttpServer();
  const adminAuth = async () => authHeader((await createMockAdminUser(context)).accessToken);

  describe('permissions', () => {
    it('declares exactly the system_settings strings the admin card uses', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AndroidAppController.prototype.get)).toEqual([
        'system_settings:read',
      ]);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AndroidAppController.prototype.replace)).toEqual([
        'system_settings:write',
      ]);
    });

    it('marks the assetlinks route public and maintenance-exempt', () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, AssetLinksController.prototype.getAssetLinks)).toBe(true);
      expect(Reflect.getMetadata(ALLOW_DURING_MAINTENANCE_KEY, AssetLinksController)).toBe(true);
      // The admin routes are NOT exempt.
      expect(Reflect.getMetadata(ALLOW_DURING_MAINTENANCE_KEY, AndroidAppController)).toBeUndefined();
    });

    it('refuses unauthenticated callers on the admin routes', async () => {
      await request(server()).get(ADMIN_ROUTE).expect(401);
      await request(server()).put(ADMIN_ROUTE).send({ trustedApps: [] }).expect(401);
    });

    it('refuses a viewer and a contributor with 403 on GET and PUT', async () => {
      for (const user of [await createMockViewerUser(context), await createMockContributorUser(context)]) {
        await request(server()).get(ADMIN_ROUTE).set(authHeader(user.accessToken)).expect(403);
        await request(server())
          .put(ADMIN_ROUTE)
          .set(authHeader(user.accessToken))
          .send({ trustedApps: [] })
          .expect(403);
      }

      expect(context.prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/android-app', () => {
    it('returns an empty state in the { data } envelope when nothing is stored or reported', async () => {
      const { body } = await request(server()).get(ADMIN_ROUTE).set(await adminAuth()).expect(200);

      expect(body.data).toEqual({ trustedApps: [], reportedApps: [], assetLinks: [] });
    });

    it('lists reported apps from active media sync devices, flagged against the trusted list', async () => {
      stored = { trustedApps: [{ packageName: PACKAGE, sha256: SHA_A }] };
      context.prismaMock.mediaSyncDevice.groupBy.mockResolvedValue([
        {
          packageName: PACKAGE,
          signingSha256: SHA_A.toLowerCase(),
          _count: { _all: 2 },
          _max: { lastSeenAt: new Date('2026-09-30T10:00:00Z') },
        },
        {
          packageName: `${PACKAGE}.debug`,
          signingSha256: SHA_B,
          _count: { _all: 1 },
          _max: { lastSeenAt: null },
        },
      ]);

      const { body } = await request(server()).get(ADMIN_ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.reportedApps).toEqual([
        {
          packageName: PACKAGE,
          sha256: SHA_A,
          deviceCount: 2,
          lastSeenAt: '2026-09-30T10:00:00.000Z',
          trusted: true,
        },
        { packageName: `${PACKAGE}.debug`, sha256: SHA_B, deviceCount: 1, lastSeenAt: null, trusted: false },
      ]);
      expect(context.prismaMock.mediaSyncDevice.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'active', packageName: { not: null }, signingSha256: { not: null } },
        }),
      );
    });
  });

  describe('PUT /api/admin/android-app', () => {
    it('normalises, de-duplicates, stores, audits and returns the new state', async () => {
      const admin = await createMockAdminUser(context);

      const { body } = await request(server())
        .put(ADMIN_ROUTE)
        .set(authHeader(admin.accessToken))
        .send({
          trustedApps: [
            { packageName: PACKAGE, sha256: SHA_A.toLowerCase() },
            { packageName: PACKAGE, sha256: SHA_B.replace(/:/g, '') },
            { packageName: PACKAGE, sha256: SHA_A },
          ],
        })
        .expect(200);

      const trustedApps = [
        { packageName: PACKAGE, sha256: SHA_A },
        { packageName: PACKAGE, sha256: SHA_B },
      ];
      expect(body.data.trustedApps).toEqual(trustedApps);
      expect(body.data.assetLinks).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: [SHA_A, SHA_B] },
        },
      ]);
      expect(stored).toEqual({ trustedApps });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: admin.id,
          action: ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION,
          targetType: 'system_settings',
          targetId: ANDROID_APP_SETTINGS_KEY,
          meta: expect.objectContaining({ count: 2, added: trustedApps, removed: [] }),
        }),
      });
    });

    it.each([
      ['a missing list', {}],
      ['no body at all', undefined],
      ['an unknown key', { trustedApps: [], extra: 1 }],
      ['a bad package name', { trustedApps: [{ packageName: 'app', sha256: SHA_A }] }],
      ['a bad fingerprint', { trustedApps: [{ packageName: PACKAGE, sha256: 'AB:CD' }] }],
      [
        'more than ten apps',
        { trustedApps: Array.from({ length: 11 }, (_, i) => ({ packageName: `com.example.a${i}`, sha256: SHA_A })) },
      ],
    ])('rejects %s with 400 carrying details.reason, and writes nothing', async (_label, payload) => {
      const req = request(server()).put(ADMIN_ROUTE).set(await adminAuth());
      const { body } = await (payload === undefined ? req : req.send(payload)).expect(400);

      expect(body.details).toEqual(
        expect.objectContaining({ reason: 'invalid_trusted_apps', issues: expect.any(Array) }),
      );
      expect(body).not.toHaveProperty('reason');
      expect(body).not.toHaveProperty('errors');
      expect(context.prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
      expect(context.prismaMock.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/well-known/assetlinks.json', () => {
    it('answers an anonymous caller with a bare array, JSON and a five-minute public cache', async () => {
      stored = {
        trustedApps: [
          { packageName: PACKAGE, sha256: SHA_A },
          { packageName: `${PACKAGE}.debug`, sha256: SHA_B },
        ],
      };

      const response = await request(server()).get(ASSET_LINKS_ROUTE).expect(200);

      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: [SHA_A] },
        },
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: `${PACKAGE}.debug`, sha256_cert_fingerprints: [SHA_B] },
        },
      ]);
    });

    it('is [] when nothing is stored, and when the stored row does not validate', async () => {
      const empty = await request(server()).get(ASSET_LINKS_ROUTE).expect(200);
      expect(empty.text).toBe('[]');

      stored = { trustedApps: 'not a list' };
      const invalid = await request(server()).get(ASSET_LINKS_ROUTE).expect(200);
      expect(invalid.body).toEqual([]);
    });

    it('stays reachable while a maintenance window is open, unlike the admin route', async () => {
      const maintenance = context.module.get(MaintenanceModeService);
      await maintenance.enable('Down for maintenance', null, { allowAdmins: false });

      try {
        await request(server()).get(ASSET_LINKS_ROUTE).expect(200);
        await request(server()).get(ADMIN_ROUTE).set(await adminAuth()).expect(503);
      } finally {
        maintenance.clearInMemoryOverride();
      }
    });
  });
});
