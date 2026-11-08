/**
 * The platform email routes as MemoriaHub mounts them (RETRO-D2, #570):
 *   GET/PUT   /api/email-settings        system_settings:read / :write
 *   POST      /api/email-settings/test   system_settings:write, to the CALLER's own address
 *
 * The routes are `@marinoscar/platform-api/email`'s; this suite proves they are
 * mounted once in the app's graph, gated on the platform permission strings,
 * read the platform `email` row (not the legacy `global.email` block), and
 * never return a secret.
 */

import request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('Email settings (platform slice) integration', () => {
  let context: TestContext;
  let originalKey: string | undefined;

  beforeAll(async () => {
    originalKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] = VALID_KEY;
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
    if (originalKey === undefined) delete process.env['SECRETS_ENCRYPTION_KEY'];
    else process.env['SECRETS_ENCRYPTION_KEY'] = originalKey;
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  /** Serve `row` for the platform `email` row and the base fixture for every other key. */
  function seedEmailRow(row: Record<string, unknown> | null, legacy?: Record<string, unknown>) {
    const findUnique = context.prismaMock.systemSettings.findUnique as jest.Mock;
    const base = findUnique.getMockImplementation();
    findUnique.mockImplementation(async (args: { where: { key?: string } }) => {
      if (args?.where?.key === 'email') {
        return row ? { id: 'email-row', key: 'email', value: row, version: 3, updatedAt: new Date(), updatedByUserId: null } : null;
      }
      if (legacy && args?.where?.key === 'global') {
        return { id: 'global-row', key: 'global', value: { email: legacy }, version: 1, updatedAt: new Date(), updatedByUserId: null };
      }
      return base ? base(args) : null;
    });
  }

  describe('GET /api/email-settings', () => {
    it('401 without auth', async () => {
      await request(context.app.getHttpServer()).get('/api/email-settings').expect(401);
    });

    it('403 for a viewer (no system_settings:read)', async () => {
      const viewer = await createMockViewerUser(context);
      await request(context.app.getHttpServer()).get('/api/email-settings').set(authHeader(viewer.accessToken)).expect(403);
    });

    it('200 for an admin: the platform row, transports folded from the flat fields, no secret', async () => {
      const admin = await createMockAdminUser(context);
      seedEmailRow(
        {
          provider: 'smtp',
          enabled: true,
          fromAddress: 'family@example.test',
          transports: { smtp: { host: 'smtp.example.test', port: 587, useTls: true, username: 'mailer@example.test' } },
        },
        // The legacy block (with its inline ciphertext) must NOT be what the page reads.
        { provider: 'ses', smtpPassword: 'v1:legacy-ciphertext' },
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const body = response.body.data ?? response.body;
      expect(body).toMatchObject({ provider: 'smtp', enabled: true, fromAddress: 'family@example.test' });
      expect(body.transports.smtp).toMatchObject({ host: 'smtp.example.test', port: 587 });
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('legacy-ciphertext');
      expect(raw).not.toMatch(/"(smtpPassword|password|secretAccessKey)"\s*:\s*"/);
    });
  });

  describe('PUT /api/email-settings', () => {
    it('403 for a viewer', async () => {
      const viewer = await createMockViewerUser(context);
      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(viewer.accessToken))
        .send({ provider: 'smtp', enabled: true })
        .expect(403);
    });
  });

  describe('POST /api/email-settings/test', () => {
    it('403 for a viewer', async () => {
      const viewer = await createMockViewerUser(context);
      await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(viewer.accessToken))
        .send({})
        .expect(403);
    });

    it('reports a disabled configuration as a result, not an error, and sends nothing', async () => {
      const admin = await createMockAdminUser(context);
      seedEmailRow({ provider: 'smtp', enabled: false, fromAddress: 'family@example.test' });

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .send({});

      expect(response.status).toBeLessThan(300);
      const body = response.body.data ?? response.body;
      expect(body.success).toBe(false);
      expect(String(body.error)).toMatch(/disabled/i);
    });
  });
});
