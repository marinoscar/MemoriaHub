import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { encryptSecret } from '../../src/common/crypto/secret-cipher';

describe('System Settings Integration', () => {
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
  });

  describe('GET /api/system-settings', () => {
    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .expect(401);
    });

    it('should return 403 for users without system_settings:read permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('should return settings for admin', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        ui: DEFAULT_SYSTEM_SETTINGS.ui,
        features: DEFAULT_SYSTEM_SETTINGS.features,
        version: expect.any(Number),
      });
      expect(response.body.data.updatedAt).toBeDefined();
    });

    it('should never include email.smtpPassword even when a value is configured', async () => {
      const admin = await createMockAdminUser(context);

      const originalKey = process.env['SECRETS_ENCRYPTION_KEY'];
      process.env['SECRETS_ENCRYPTION_KEY'] = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';
      const ciphertext = encryptSecret('super-secret-smtp-password');
      if (originalKey === undefined) {
        delete process.env['SECRETS_ENCRYPTION_KEY'];
      } else {
        process.env['SECRETS_ENCRYPTION_KEY'] = originalKey;
      }

      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          email: {
            provider: 'smtp',
            enabled: true,
            fromAddress: 'noreply@example.com',
            smtpHost: 'smtp.example.com',
            smtpPassword: ciphertext,
          },
        },
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      } as any);

      // Force a fresh read past the 5s in-process settings cache.
      const settingsService = context.module.get(SystemSettingsService);
      (settingsService as any).settingsCache = null;

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const bodyStr = JSON.stringify(response.body);
      expect(bodyStr).not.toContain('smtpPassword');
      expect(bodyStr).not.toContain(ciphertext);
      expect(bodyStr).not.toContain('super-secret-smtp-password');

      if (response.body.data.email) {
        expect(response.body.data.email).not.toHaveProperty('smtpPassword');
      }
    });

    // Note: ETag header not currently implemented in controller
  });

  describe.skip('PUT /api/system-settings', () => {
    // Pre-existing type gap (unrelated to the email feature): SystemSettingsValue
    // has since grown several required top-level sections (ai, face, storage, ...).
    // Spread the defaults so this fixture still satisfies the type without
    // hand-maintaining every section here; this block is skipped at runtime.
    const newSettings: SystemSettingsValue = {
      ...DEFAULT_SYSTEM_SETTINGS,
      ui: { allowUserThemeOverride: false },
      features: { newFeature: true },
    };

    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .send(newSettings)
        .expect(401);
    });

    it('should return 403 for users without system_settings:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send(newSettings)
        .expect(403);
    });

    it('should replace settings for admin', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.systemSettings.upsert.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: newSettings as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(newSettings)
        .expect(200);

      expect(response.body.data).toMatchObject({
        ui: newSettings.ui,
        features: newSettings.features,
        version: 2,
      });
    });

    // Note: ETag header not currently implemented in controller

    it('should return 400 with invalid settings structure', async () => {
      const admin = await createMockAdminUser(context);

      const invalidSettings = {
        ui: { allowUserThemeOverride: 'not-a-boolean' },
        features: {},
      };

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(invalidSettings)
        .expect(400);
    });

    it('should return 400 with missing required fields', async () => {
      const admin = await createMockAdminUser(context);

      const incompleteSettings = {
        // Missing ui field
        features: {},
      };

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(incompleteSettings)
        .expect(400);
    });
  });

  describe('PATCH /api/system-settings', () => {
    beforeEach(() => {
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });
    });

    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .send({ ui: { allowUserThemeOverride: false } })
        .expect(401);
    });

    it('should return 403 for users without system_settings:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ ui: { allowUserThemeOverride: false } })
        .expect(403);
    });

    it('should merge settings for admin', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { ui: { allowUserThemeOverride: false } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.ui.allowUserThemeOverride).toBe(false);
      expect(response.body.data.features).toEqual(DEFAULT_SYSTEM_SETTINGS.features);
      expect(response.body.data.version).toBe(2);
    });

    it('should return 412 when If-Match does not match ETag', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { ui: { allowUserThemeOverride: false } };

      // Current version is 1, but If-Match header expects version 2
      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .set('If-Match', '2')
        .send(partialUpdate)
        .expect(409); // ConflictException returns 409

      expect(response.body.message).toContain('version mismatch');
    });

    it('should succeed when If-Match matches current version', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { ui: { allowUserThemeOverride: false } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      // Current version is 1, If-Match header expects version 1
      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .set('If-Match', '1')
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.version).toBe(2);
    });

    it('should work without If-Match header', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { ui: { allowUserThemeOverride: false } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.version).toBe(2);
    });

    it('should handle features object updates', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { features: { betaFeature: true } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ui: DEFAULT_SYSTEM_SETTINGS.ui,
          features: { betaFeature: true },
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.features).toEqual({ betaFeature: true });
    });

    it('should return 400 with invalid partial update', async () => {
      const admin = await createMockAdminUser(context);

      const invalidUpdate = { ui: { allowUserThemeOverride: 'invalid' } };

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(invalidUpdate)
        .expect(400);
    });
  });
});
