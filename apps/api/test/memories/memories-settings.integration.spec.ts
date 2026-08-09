/**
 * Integration tests for the Memories configuration surface (epic #300, issue #302).
 *
 * Covers the three HTTP-visible pieces this issue ships:
 *   1. PATCH /api/system-settings round-trips every `memories.*` key, and
 *      rejects out-of-bounds values with a 400.
 *   2. GET /api/features exposes `memories` to any authenticated user (it is the
 *      least-privilege path non-admin clients read gated affordances from).
 *   3. PUT /api/ai/features/memories persists the provider/model pair, refuses a
 *      provider with no enabled credential, and is Admin + ai_settings:write.
 *
 * Runs against the mocked Prisma client, so the assertion for a persisted value
 * is made against the argument handed to `systemSettings.update` — that is the
 * document the service actually wrote, after its deep merge and schema parse.
 */

import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';

describe('Memories settings integration (issue #302)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    // SystemSettingsService caches for 5 s in process, and the app instance is
    // shared across the whole file — without this, one test's settings row is
    // still being served to the next.
    (context.module.get(SystemSettingsService) as any).settingsCache = null;
  });

  /**
   * Layers `ai_settings:read` + `ai_settings:write` onto the JWT-resolved user
   * row. The shared `mockPermissions` fixture has no ai_settings entries, so an
   * admin created by `createMockAdminUser` cannot reach /api/ai/*; this grants
   * them per-test without mutating the shared fixture. Same technique as
   * `grantNodePermissions` in workflow-node-execution.integration.spec.ts.
   */
  function grantAiSettingsPermissions(userId: string): void {
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
              { permission: { id: 'perm-ai-read', name: 'ai_settings:read' } },
              { permission: { id: 'perm-ai-write', name: 'ai_settings:write' } },
            ],
          },
        })),
      };
    });
  }

  /** Seed the mocked settings row and capture whatever the service writes. */
  function stubSettingsRow(value: unknown = DEFAULT_SYSTEM_SETTINGS) {
    context.prismaMock.systemSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      key: 'global',
      value: value as any,
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: null,
      updatedByUser: null,
    });
    context.prismaMock.systemSettings.update.mockImplementation((args: any) =>
      Promise.resolve({
        id: 'settings-1',
        key: 'global',
        value: args.data.value,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      }),
    );
    context.prismaMock.auditEvent.create.mockResolvedValue({} as any);
  }

  /** The `memories` block the service actually persisted. */
  function persistedMemories(): any {
    const call = context.prismaMock.systemSettings.update.mock.calls.at(-1);
    return (call?.[0] as any).data.value.memories;
  }

  // -------------------------------------------------------------------------
  // 1. memories.* namespace
  // -------------------------------------------------------------------------

  describe('PATCH /api/system-settings — memories.*', () => {
    beforeEach(() => stubSettingsRow());

    it('ships the documented defaults', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.memories).toEqual({
        generation: { intervalHours: 24 },
        maxItemsPerMemory: 30,
        aiTitles: { enabled: true },
        onThisDay: { enabled: true, lookbackYears: 10, minItems: 3 },
        trips: {
          enabled: true,
          minDays: 2,
          minItems: 10,
          minDistanceKm: 50,
          lookbackMonths: 18,
        },
        people: { enabled: true, favoritesOnly: true, minItems: 8 },
        themes: { enabled: true, minItems: 8, maxPerPeriod: 3 },
        seasonal: { enabled: true, minItems: 12 },
        yearInReview: { enabled: true, minItems: 15 },
        digest: {
          enabled: true,
          frequency: 'weekly',
          sendHourUtc: 8,
          imageTokenTtlDays: 30,
        },
      });
    });

    it('round-trips every memories.* key', async () => {
      const admin = await createMockAdminUser(context);

      const update = {
        memories: {
          generation: { intervalHours: 6 },
          maxItemsPerMemory: 50,
          aiTitles: { enabled: false },
          onThisDay: { enabled: false, lookbackYears: 25, minItems: 5 },
          trips: {
            enabled: false,
            minDays: 3,
            minItems: 20,
            minDistanceKm: 120,
            lookbackMonths: 36,
          },
          people: { enabled: false, favoritesOnly: false, minItems: 12 },
          themes: { enabled: false, minItems: 15, maxPerPeriod: 7 },
          seasonal: { enabled: false, minItems: 40 },
          yearInReview: { enabled: false, minItems: 60 },
          digest: {
            enabled: false,
            frequency: 'monthly',
            sendHourUtc: 0,
            imageTokenTtlDays: 90,
          },
        },
      };

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(update)
        .expect(200);

      expect(response.body.data.memories).toEqual(update.memories);
      expect(persistedMemories()).toEqual(update.memories);
    });

    it('merges a single nested key without disturbing its siblings', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ memories: { onThisDay: { minItems: 5 } } })
        .expect(200);

      const memories = persistedMemories();
      expect(memories.onThisDay).toEqual({
        enabled: true,
        lookbackYears: 10,
        minItems: 5,
      });
      expect(memories.trips.minDistanceKm).toBe(50);
      expect(memories.generation.intervalHours).toBe(24);
    });

    it.each([
      ['generation.intervalHours below min', { generation: { intervalHours: 0 } }],
      ['generation.intervalHours above max', { generation: { intervalHours: 169 } }],
      ['generation.intervalHours non-integer', { generation: { intervalHours: 1.5 } }],
      ['maxItemsPerMemory below min', { maxItemsPerMemory: 4 }],
      ['maxItemsPerMemory above max', { maxItemsPerMemory: 101 }],
      ['onThisDay.lookbackYears above max', { onThisDay: { lookbackYears: 51 } }],
      ['onThisDay.minItems above max', { onThisDay: { minItems: 21 } }],
      ['trips.minDays above max', { trips: { minDays: 15 } }],
      ['trips.minDistanceKm below min', { trips: { minDistanceKm: 4 } }],
      ['trips.lookbackMonths above max', { trips: { lookbackMonths: 241 } }],
      ['people.minItems below min', { people: { minItems: 2 } }],
      ['themes.maxPerPeriod above max', { themes: { maxPerPeriod: 11 } }],
      ['seasonal.minItems below min', { seasonal: { minItems: 4 } }],
      ['yearInReview.minItems above max', { yearInReview: { minItems: 101 } }],
      ['digest.frequency not in the enum', { digest: { frequency: 'hourly' } }],
      ['digest.sendHourUtc above max', { digest: { sendHourUtc: 24 } }],
      ['digest.imageTokenTtlDays below min', { digest: { imageTokenTtlDays: 6 } }],
      ['aiTitles.enabled wrong type', { aiTitles: { enabled: 'yes' } }],
    ])('rejects %s with 400', async (_label, memories) => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ memories })
        .expect(400);
    });

    it('accepts the inclusive bounds at both ends', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({
          memories: {
            generation: { intervalHours: 1 },
            maxItemsPerMemory: 100,
            digest: { sendHourUtc: 23, imageTokenTtlDays: 7 },
          },
        })
        .expect(200);

      const memories = persistedMemories();
      expect(memories.generation.intervalHours).toBe(1);
      expect(memories.maxItemsPerMemory).toBe(100);
      expect(memories.digest.sendHourUtc).toBe(23);
    });
  });

  // -------------------------------------------------------------------------
  // 2. features.memories via GET /api/features
  // -------------------------------------------------------------------------

  describe('GET /api/features — features.memories', () => {
    it('reports memories: false by default', async () => {
      stubSettingsRow();
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/features')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.features.memories).toBe(false);
    });

    it('reports memories: true once the flag is enabled', async () => {
      stubSettingsRow({
        ...DEFAULT_SYSTEM_SETTINGS,
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, memories: true },
      });
      // Deliberately a NON-admin: /api/features exists precisely so ordinary
      // circle members can resolve gated affordances without system_settings:read.
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/features')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.features.memories).toBe(true);
    });

    it('toggles through PATCH /api/system-settings', async () => {
      stubSettingsRow();
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ features: { memories: true } })
        .expect(200);

      expect(response.body.data.features.memories).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. PUT /api/ai/features/memories
  // -------------------------------------------------------------------------

  describe('PUT /api/ai/features/memories', () => {
    beforeEach(() => stubSettingsRow());

    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .put('/api/ai/features/memories')
        .send({ provider: 'openai', model: 'gpt-4o-mini' })
        .expect(401);
    });

    it('returns 403 without ai_settings:write', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/ai/features/memories')
        .set(authHeader(viewer.accessToken))
        .send({ provider: 'openai', model: 'gpt-4o-mini' })
        .expect(403);
    });

    it('persists the provider/model pair for an admin', async () => {
      const admin = await createMockAdminUser(context);
      grantAiSettingsPermissions(admin.id);
      context.prismaMock.aiProviderCredential.findUnique.mockResolvedValue({
        enabled: true,
      } as any);

      const response = await request(context.app.getHttpServer())
        .put('/api/ai/features/memories')
        .set(authHeader(admin.accessToken))
        .send({ provider: 'openai', model: 'gpt-4o-mini' })
        .expect(200);

      expect(response.body.data).toEqual({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });

      const call = context.prismaMock.systemSettings.update.mock.calls.at(-1);
      expect((call?.[0] as any).data.value.ai.features.memories).toEqual({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
    });

    it('returns 400 when the provider has no configured credential', async () => {
      const admin = await createMockAdminUser(context);
      grantAiSettingsPermissions(admin.id);
      context.prismaMock.aiProviderCredential.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .put('/api/ai/features/memories')
        .set(authHeader(admin.accessToken))
        .send({ provider: 'openai', model: 'gpt-4o-mini' })
        .expect(400);

      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('returns 400 when the provider credential is disabled', async () => {
      const admin = await createMockAdminUser(context);
      grantAiSettingsPermissions(admin.id);
      context.prismaMock.aiProviderCredential.findUnique.mockResolvedValue({
        enabled: false,
      } as any);

      await request(context.app.getHttpServer())
        .put('/api/ai/features/memories')
        .set(authHeader(admin.accessToken))
        .send({ provider: 'openai', model: 'gpt-4o-mini' })
        .expect(400);
    });

    it('clears the selection when a field is null (fall back to template titles)', async () => {
      const admin = await createMockAdminUser(context);
      grantAiSettingsPermissions(admin.id);

      const response = await request(context.app.getHttpServer())
        .put('/api/ai/features/memories')
        .set(authHeader(admin.accessToken))
        .send({ provider: null, model: null })
        .expect(200);

      expect(response.body.data).toBeNull();
      const call = context.prismaMock.systemSettings.update.mock.calls.at(-1);
      expect((call?.[0] as any).data.value.ai.features.memories).toBeNull();
    });

    it('surfaces the configured pair in GET /api/ai/settings', async () => {
      stubSettingsRow({
        ...DEFAULT_SYSTEM_SETTINGS,
        ai: {
          features: {
            ...DEFAULT_SYSTEM_SETTINGS.ai.features,
            memories: { provider: 'openai', model: 'gpt-4o-mini' },
          },
        },
      });
      const admin = await createMockAdminUser(context);
      grantAiSettingsPermissions(admin.id);
      context.prismaMock.aiProviderCredential.findMany.mockResolvedValue([]);

      const response = await request(context.app.getHttpServer())
        .get('/api/ai/settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.features.memories).toEqual({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
    });
  });
});
