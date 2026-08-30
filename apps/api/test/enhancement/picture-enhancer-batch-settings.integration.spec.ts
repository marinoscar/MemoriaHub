/**
 * Integration test for `pictureEnhancement.maxBatchSize` (epic #420, issue #421).
 *
 * The repo has a documented, real failure mode here: system settings are
 * hand-duplicated across THREE files — `systemSettingsSchema` +
 * `systemSettingsPatchSchema` (validation/merge) and, separately, the wire DTO
 * `patchSystemSettingsSchema` in `settings/dto/update-system-settings.dto.ts`
 * that `nestjs-zod` actually validates the HTTP request body against and which
 * STRIPS UNKNOWN KEYS. A namespace/field present only in the first two passes
 * every unit test asserting against the Zod schema directly while every real
 * `PATCH /api/system-settings` silently no-ops. Asserting only against
 * `patchSystemSettingsSchema.parse(...)` (as update-system-settings.dto.spec.ts
 * does for other namespaces) would NOT catch that class of bug for this field,
 * because it only exercises schema #1/#2's twin, not the wire boundary.
 *
 * This file therefore drives the assertion through a REAL HTTP request
 * (supertest, mocked Prisma only — the same pattern as
 * test/memories/memories-settings.integration.spec.ts), so a regression that
 * reintroduces the trap (e.g. a future edit to `maxBatchSize` that forgets one
 * of the three copies) fails here even though it would pass a schema-only test.
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

describe('pictureEnhancement.maxBatchSize settings integration (issue #421)', () => {
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

  /** The `pictureEnhancement` block the service actually persisted. */
  function persistedPictureEnhancement(): any {
    const call = context.prismaMock.systemSettings.update.mock.calls.at(-1);
    return (call?.[0] as any).data.value.pictureEnhancement;
  }

  // -------------------------------------------------------------------------
  // 1. PATCH /api/system-settings — the wire-level round-trip
  // -------------------------------------------------------------------------

  describe('PATCH /api/system-settings — pictureEnhancement.maxBatchSize', () => {
    beforeEach(() => stubSettingsRow());

    it('ships the documented default of 25', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.pictureEnhancement.maxBatchSize).toBe(25);
    });

    it('round-trips a new maxBatchSize through the REAL HTTP PATCH request (not just the Zod schema)', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: 10 } })
        .expect(200);

      // The HTTP response reflects the new value...
      expect(response.body.data.pictureEnhancement.maxBatchSize).toBe(10);
      // ...and it is what the service actually persisted, proving the wire DTO
      // did not strip the field before it ever reached SystemSettingsService.
      expect(persistedPictureEnhancement().maxBatchSize).toBe(10);
    });

    it('merges maxBatchSize without disturbing its pictureEnhancement siblings', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: 5 } })
        .expect(200);

      const persisted = persistedPictureEnhancement();
      expect(persisted.maxBatchSize).toBe(5);
      expect(persisted.defaultQuality).toBe(DEFAULT_SYSTEM_SETTINGS.pictureEnhancement!.defaultQuality);
      expect(persisted.allowReplace).toBe(DEFAULT_SYSTEM_SETTINGS.pictureEnhancement!.allowReplace);
    });

    it('accepts the inclusive bounds (1 and 200)', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: 1 } })
        .expect(200);
      expect(persistedPictureEnhancement().maxBatchSize).toBe(1);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: 200 } })
        .expect(200);
      expect(persistedPictureEnhancement().maxBatchSize).toBe(200);
    });

    it.each([
      ['below the min (0)', 0],
      ['above the max (201)', 201],
      ['a non-integer', 5.5],
    ])('rejects maxBatchSize %s with 400', async (_label, value) => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: value } })
        .expect(400);

      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('returns 403 for a caller without system_settings:write', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: 10 } })
        .expect(403);

      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 2. GET /api/features — the least-privilege carrier a non-admin client
  //    actually reads the cap from before submitting a bulk-enhance batch.
  // -------------------------------------------------------------------------

  describe('GET /api/features — pictureEnhancement.maxBatchSize', () => {
    it('surfaces the default maxBatchSize of 25 to a non-admin caller', async () => {
      stubSettingsRow();
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/features')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.pictureEnhancement.maxBatchSize).toBe(25);
    });

    it('reflects a persisted non-default maxBatchSize', async () => {
      stubSettingsRow({
        ...DEFAULT_SYSTEM_SETTINGS,
        pictureEnhancement: { ...DEFAULT_SYSTEM_SETTINGS.pictureEnhancement, maxBatchSize: 7 },
      });
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/features')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.pictureEnhancement.maxBatchSize).toBe(7);
    });

    it('reflects a value just written via PATCH /api/system-settings — end-to-end round trip', async () => {
      stubSettingsRow();
      const admin = await createMockAdminUser(context);
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ pictureEnhancement: { maxBatchSize: 42 } })
        .expect(200);

      // GET /api/features reads through the same cached SystemSettingsService,
      // so invalidate the in-process cache the same way stubSettingsRow's
      // beforeEach does before every OTHER test in this file.
      (context.module.get(SystemSettingsService) as any).settingsCache = null;
      // The mocked findUnique must now serve the row the PATCH just wrote.
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: persistedPictureEnhancementAsFullSettings(),
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/features')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.pictureEnhancement.maxBatchSize).toBe(42);
    });

    /** Reconstructs the full settings document last written by systemSettings.update. */
    function persistedPictureEnhancementAsFullSettings(): any {
      const call = context.prismaMock.systemSettings.update.mock.calls.at(-1);
      return (call?.[0] as any).data.value;
    }
  });
});
