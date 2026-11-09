/**
 * The platform exports slice is mounted (RETRO-H2, #596).
 *
 * Boots the whole AppModule against the mocked Prisma client and checks:
 *   - the slice's service and both job handlers write through MemoriaHub's storage adapter
 *     (`ExportsHostModule` overrides the platform `STORAGE_PROVIDER` for the slice only,
 *     PLATFORM-ADOPTION-SHIM(RETRO-D1));
 *   - `GET /api/exports/sources` offers `user-data` and the four MemoriaHub sources to a
 *     holder of `media:read`, as JSON, CSV and XLSX, and `org-data` only with `org_members:read`;
 *   - another user's export id answers 404, never 403 (enumeration-resistant).
 */

import request from 'supertest';
import { ExportPurgeHandler, ExportRunHandler, ExportsService } from '@marinoscar/platform-api/exports';

import { ExportsStorageAdapter } from '../../src/platform/exports/exports-storage.adapter';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockViewerUser } from '../helpers/auth-mock.helper';

const MEMORIAHUB_SOURCES = ['memoriahub-media', 'memoriahub-albums', 'memoriahub-memories', 'memoriahub-people'];

describe('platform exports slice mount (RETRO-H2)', () => {
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
  });

  /** Adds permission names to one user's role graph. */
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

  it('binds the slice to MemoriaHub storage, not the unconfigured platform provider', () => {
    const adapter = context.module.get(ExportsStorageAdapter, { strict: false });
    expect(adapter).toBeInstanceOf(ExportsStorageAdapter);
    for (const token of [ExportsService, ExportRunHandler, ExportPurgeHandler]) {
      const instance = context.module.get(token as never, { strict: false }) as { storage: unknown };
      expect(instance.storage).toBe(adapter);
    }
  });

  it('offers user-data and the four MemoriaHub sources, without org-data, to a media reader', async () => {
    const viewer = await createMockViewerUser(context);
    grant(viewer.id, ['user_settings:read', 'media:read']);
    const res = await request(context.app.getHttpServer())
      .get('/api/exports/sources')
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(200);
    const items = res.body.data.items as { id: string; formats: { id: string }[] }[];
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['user-data', ...MEMORIAHUB_SOURCES]));
    expect(ids).not.toContain('org-data');
    for (const id of MEMORIAHUB_SOURCES) {
      expect(items.find((item) => item.id === id)!.formats.map((f) => f.id)).toEqual(['json', 'csv', 'xlsx']);
    }
  });

  it('offers org-data to a holder of org_members:read', async () => {
    const viewer = await createMockViewerUser(context);
    grant(viewer.id, ['user_settings:read', 'media:read', 'org_members:read']);
    const res = await request(context.app.getHttpServer())
      .get('/api/exports/sources')
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(200);
    expect((res.body.data.items as { id: string }[]).map((item) => item.id)).toContain('org-data');
  });

  it("answers 404, never 403, for another user's export", async () => {
    const viewer = await createMockViewerUser(context);
    grant(viewer.id, ['user_settings:read', 'media:read']);
    const otherUserId = '99999999-0000-4000-8000-000000000001';
    const exportId = '88888888-0000-4000-8000-000000000001';
    (context.prismaMock.job.findFirst as jest.Mock).mockResolvedValue({
      id: exportId,
      type: 'export.run',
      status: 'succeeded',
      subjectType: 'user',
      subjectId: otherUserId,
      payload: {
        source: 'memoriahub-media',
        format: 'json',
        request: {},
        requestedById: otherUserId,
        scope: 'user',
        subjectId: otherUserId,
        orgId: '77777777-0000-4000-8000-000000000001',
        timeZone: 'UTC',
      },
      attempts: 1,
      lastError: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const res = await request(context.app.getHttpServer())
      .get(`/api/exports/${exportId}`)
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(404);
  });
});
