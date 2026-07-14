/**
 * Integration tests for the email settings endpoints:
 *   GET/PUT   /api/email-settings
 *   POST      /api/email-settings/test
 *
 * Mirrors apps/api/test/settings/system-settings.integration.spec.ts's
 * full-app-boot supertest pattern (createTestApp with a mocked PrismaService).
 *
 * SECRETS_ENCRYPTION_KEY is set for the whole file (like
 * apps/api/src/geo/geo-settings.service.spec.ts) since PUT with a new
 * smtpPassword exercises the real encrypt/decrypt round-trip.
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
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { EmailService } from '../../src/email/email.service';
import { encryptSecret, decryptSecret } from '../../src/common/crypto/secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('Email Settings Integration', () => {
  let context: TestContext;
  let originalKey: string | undefined;

  beforeAll(async () => {
    originalKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] = VALID_KEY;

    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);

    if (originalKey === undefined) {
      delete process.env['SECRETS_ENCRYPTION_KEY'];
    } else {
      process.env['SECRETS_ENCRYPTION_KEY'] = originalKey;
    }
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();

    // SystemSettingsService caches getSettings() results in-process for 5s.
    // Force a fresh read on every test so each test's mocked DB state is honored.
    const settingsService = context.module.get(SystemSettingsService);
    (settingsService as any).settingsCache = null;
  });

  /** Seed the mocked systemSettings row with a given `email` block. */
  function seedEmailSettings(email: Record<string, unknown> | null) {
    context.prismaMock.systemSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      key: 'global',
      value: {
        ui: { allowUserThemeOverride: true },
        features: {},
        email,
      },
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: null,
      updatedByUser: null,
    } as any);
  }

  // ---------------------------------------------------------------------------
  // GET /api/email-settings
  // ---------------------------------------------------------------------------

  describe('GET /api/email-settings', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .expect(401);
    });

    it('returns 403 for a non-admin (viewer)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('returns 200 with masked settings for an admin, never containing the raw password', async () => {
      const admin = await createMockAdminUser(context);
      const ciphertext = encryptSecret('super-secret-smtp-password');
      seedEmailSettings({
        provider: 'smtp',
        enabled: true,
        fromAddress: 'noreply@example.com',
        fromName: 'MemoriaHub',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUseTls: true,
        smtpUsername: 'smtp-user',
        smtpPassword: ciphertext,
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const bodyStr = JSON.stringify(response.body);
      expect(bodyStr).not.toContain('smtpPassword');
      expect(bodyStr).not.toContain(ciphertext);
      expect(bodyStr).not.toContain('super-secret-smtp-password');

      expect(response.body.data ?? response.body).toMatchObject({
        provider: 'smtp',
        enabled: true,
        fromAddress: 'noreply@example.com',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /api/email-settings
  // ---------------------------------------------------------------------------

  describe('PUT /api/email-settings', () => {
    beforeEach(() => {
      seedEmailSettings(null);
    });

    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .send({ provider: 'smtp', enabled: true })
        .expect(401);
    });

    it('returns 403 for a non-admin (viewer)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(viewer.accessToken))
        .send({ provider: 'smtp', enabled: true })
        .expect(403);
    });

    it('returns 200 for an admin and never echoes a raw password back', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .send({
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpUsername: 'smtp-user',
          smtpPassword: 'brand-new-plaintext-password',
          fromAddress: 'noreply@example.com',
        })
        .expect(200);

      const bodyStr = JSON.stringify(response.body);
      expect(bodyStr).not.toContain('smtpPassword');
      expect(bodyStr).not.toContain('brand-new-plaintext-password');

      // The encrypted value handed to patchSettings must round-trip.
      const patchCall = context.prismaMock.systemSettings.update.mock.calls.slice(-1)[0][0];
      const persistedCiphertext = patchCall.data.value.email.smtpPassword;
      expect(persistedCiphertext).not.toBe('brand-new-plaintext-password');
      expect(decryptSecret(persistedCiphertext)).toBe('brand-new-plaintext-password');
    });

    it('preserves the stored password when smtpPassword is omitted from the request', async () => {
      const admin = await createMockAdminUser(context);
      const existingCiphertext = encryptSecret('already-stored-password');
      seedEmailSettings({
        provider: 'smtp',
        enabled: true,
        fromAddress: 'noreply@example.com',
        smtpHost: 'smtp.example.com',
        smtpPassword: existingCiphertext,
      });

      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .send({
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          fromAddress: 'noreply@example.com',
        })
        .expect(200);

      const patchCall = context.prismaMock.systemSettings.update.mock.calls.slice(-1)[0][0];
      expect(patchCall.data.value.email.smtpPassword).toBe(existingCiphertext);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/email-settings/test
  // ---------------------------------------------------------------------------

  describe('POST /api/email-settings/test', () => {
    it('returns 403 for a non-admin (viewer)', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(viewer.accessToken))
        .send({ recipient: 'someone@example.com' })
        .expect(403);
    });

    it('returns {ok:true, messageId} when the underlying send succeeds', async () => {
      const admin = await createMockAdminUser(context);
      const emailService = context.module.get(EmailService);
      jest.spyOn(emailService, 'sendEmail').mockResolvedValue({
        success: true,
        messageId: 'test-message-1',
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .send({ recipient: 'someone@example.com' })
        .expect(200);

      const body = response.body.data ?? response.body;
      expect(body.ok).toBe(true);
      expect(body.messageId).toBe('test-message-1');
    });

    it('returns {ok:false, error} when the underlying send fails (feature disabled)', async () => {
      const admin = await createMockAdminUser(context);
      const emailService = context.module.get(EmailService);
      jest.spyOn(emailService, 'sendEmail').mockResolvedValue({
        success: false,
        error: 'email_disabled',
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .send({ recipient: 'someone@example.com' })
        .expect(200);

      const body = response.body.data ?? response.body;
      expect(body.ok).toBe(false);
      expect(body.error).toBe('email_disabled');
    });

    it('returns 400 for an invalid recipient email', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .send({ recipient: 'not-an-email' })
        .expect(400);
    });
  });
});
