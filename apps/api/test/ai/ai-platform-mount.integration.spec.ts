/**
 * The platform AI slice is mounted (RETRO-E1, #595).
 *
 * Boots the whole AppModule against the mocked Prisma client and checks the
 * acceptance criteria that do not need a provider:
 *   - `GET /api/ai/config` answers any signed-in user, and reports the kill
 *     switch OFF (the default: no administrator has turned platform AI on);
 *   - `/api/admin/ai/*` requires `ai_config:read` (403 without it) and is NOT
 *     behind the kill switch;
 *   - a consumer route is refused while the kill switch is off;
 *   - MemoriaHub's model listing lives at `GET /api/admin/memoriahub-ai/models`
 *     (`ai_config:read`, RETRO-E4), and the old `/api/ai/settings` is gone.
 */

import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

describe('platform AI slice mount (RETRO-E1)', () => {
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

  it('GET /api/ai/config answers a signed-in user and reports AI off', async () => {
    const viewer = await createMockViewerUser(context);
    const res = await request(context.app.getHttpServer())
      .get('/api/ai/config')
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it('GET /api/admin/ai/config needs ai_config:read and is not behind the kill switch', async () => {
    const viewer = await createMockViewerUser(context);
    const denied = await request(context.app.getHttpServer())
      .get('/api/admin/ai/config')
      .set(authHeader(viewer.accessToken));
    expect(denied.status).toBe(403);

    const admin = await createMockAdminUser(context);
    grant(admin.id, ['ai_config:read']);
    const res = await request(context.app.getHttpServer())
      .get('/api/admin/ai/config')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it('refuses a consumer call while the kill switch is off', async () => {
    const admin = await createMockAdminUser(context);
    grant(admin.id, ['ai:use']);
    const res = await request(context.app.getHttpServer())
      .post('/api/ai/responses')
      .set(authHeader(admin.accessToken))
      .send({ input: 'hello' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('AI_DISABLED');
  });

  it('serves the MemoriaHub model listing at /api/admin/memoriahub-ai/models behind ai_config:read', async () => {
    (context.prismaMock.aiProviderCredential.findUnique as jest.Mock).mockResolvedValue(null);

    const viewer = await createMockViewerUser(context);
    const denied = await request(context.app.getHttpServer())
      .get('/api/admin/memoriahub-ai/models?provider=openai&capability=transcription')
      .set(authHeader(viewer.accessToken));
    expect(denied.status).toBe(403);

    const admin = await createMockAdminUser(context);
    grant(admin.id, ['ai_config:read']);
    const res = await request(context.app.getHttpServer())
      .get('/api/admin/memoriahub-ai/models?provider=openai&capability=transcription')
      .set(authHeader(admin.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']);
  });

  it('retired the old AI admin routes (RETRO-E4): /api/ai/settings is not routed', async () => {
    const admin = await createMockAdminUser(context);
    grant(admin.id, ['ai_config:read']);
    const res = await request(context.app.getHttpServer())
      .get('/api/ai/settings')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });
});
