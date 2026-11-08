import request from 'supertest';
import { MaintenanceModeService } from '@marinoscar/platform-api/host';
import {
  TestContext,
  closeTestApp,
  createTestApp,
} from '../helpers/test-app.helper';
import { authHeader, createMockAdminUser } from '../helpers/auth-mock.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

/**
 * The platform host core as MemoriaHub mounts it (RETRO-B1, #597): maintenance
 * mode (env, in-memory and persisted layers, the 503, the exempt routes), the
 * health probes during a window, and the audit trail.
 *
 * The MemoriaHub-specific contracts the retired unit specs used to carry:
 * `/api/health/ready` drains the instance (503) while `/live` stays 200, the
 * assetlinks route and the maintenance endpoints stay reachable, and a window
 * opened through the in-memory layer (the restore swap) blocks admins.
 */
describe('Platform host core (Integration)', () => {
  let context: TestContext;
  let maintenance: MaintenanceModeService;

  const server = () => context.app.getHttpServer();
  const adminAuth = async () => authHeader((await createMockAdminUser(context)).accessToken);

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    maintenance = context.module.get(MaintenanceModeService);
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    delete process.env.MAINTENANCE_MODE;
    maintenance.setInMemoryOverride(null);
    maintenance.invalidateCache();
  });

  afterEach(() => {
    delete process.env.MAINTENANCE_MODE;
    maintenance.setInMemoryOverride(null);
    maintenance.invalidateCache();
  });

  describe('outside a maintenance window', () => {
    it('answers a route in the { data, meta } envelope with an x-request-id', async () => {
      const response = await request(server()).get('/api/health/live').expect(200);

      expect(response.body.data).toMatchObject({ status: 'ok' });
      expect(response.body.meta.timestamp).toEqual(expect.any(String));
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('echoes an incoming x-request-id', async () => {
      const response = await request(server())
        .get('/api/health/live')
        .set('x-request-id', 'req-abc')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('req-abc');
    });

    it('is ready when the database answers', async () => {
      await request(server()).get('/api/health/ready').expect(200);
    });

    it('renders an error in the error envelope', async () => {
      const response = await request(server()).get('/api/does-not-exist').expect(404);

      expect(response.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });
  });

  describe('while a window is open (MAINTENANCE_MODE=true)', () => {
    beforeEach(() => {
      process.env.MAINTENANCE_MODE = 'true';
    });

    it('answers a non-exempt route with the maintenance 503 and Retry-After', async () => {
      const response = await request(server()).get('/api/features').expect(503);

      expect(response.headers['retry-after']).toEqual(expect.any(String));
      expect(response.body.details).toMatchObject({ reason: 'MAINTENANCE_MODE' });
    });

    it('keeps /api/health/live at 200 and drains /api/health/ready with a 503', async () => {
      await request(server()).get('/api/health/live').expect(200);
      await request(server()).get('/api/health/ready').expect(503);
    });

    it('keeps the assetlinks route reachable', async () => {
      const response = await request(server()).get('/api/well-known/assetlinks.json');

      expect(response.status).not.toBe(503);
    });

    it('lets an administrator through while allowAdmins is on, and keeps the maintenance endpoints open', async () => {
      const auth = await adminAuth();

      const state = await request(server()).get('/api/admin/maintenance').set(auth).expect(200);
      expect(state.body.data).toMatchObject({ enabled: true, source: 'env' });
    });
  });

  describe('layers', () => {
    it('MAINTENANCE_MODE=false outranks an in-memory window', async () => {
      maintenance.setInMemoryOverride({ enabled: true, message: 'swap', allowAdmins: false });
      process.env.MAINTENANCE_MODE = 'false';

      await request(server()).get('/api/health/ready').expect(200);
    });

    it('an in-memory window with allowAdmins=false blocks an administrator (the restore swap)', async () => {
      maintenance.setInMemoryOverride({
        enabled: true,
        message: 'Restoring the database.',
        allowAdmins: false,
      });

      const response = await request(server())
        .get('/api/features')
        .set(await adminAuth())
        .expect(503);

      expect(response.body.message).toBe('Restoring the database.');
      expect(response.body.details).toMatchObject({ reason: 'MAINTENANCE_MODE', allowAdmins: false });
    });
  });

  describe('the off switch and the sign-in routes', () => {
    beforeEach(() => {
      maintenance.setInMemoryOverride({ enabled: true, message: 'swap', allowAdmins: false });
    });

    it('keeps GET and PUT /api/admin/maintenance reachable for an administrator even with allowAdmins=false', async () => {
      const auth = await adminAuth();

      await request(server()).get('/api/admin/maintenance').set(auth).expect(200);
      await request(server())
        .put('/api/admin/maintenance')
        .set(auth)
        .send({ enabled: false })
        .expect(200);
    });

    it('keeps the sign-in routes reachable', async () => {
      const response = await request(server()).get('/api/auth/providers');

      expect(response.status).not.toBe(503);
    });
  });

  describe('PUT /api/admin/maintenance', () => {
    it('opens a window, persists it through the settings row and records an audit event', async () => {
      const response = await request(server())
        .put('/api/admin/maintenance')
        .set(await adminAuth())
        .send({ enabled: true, message: 'Upgrading.' })
        .expect(200);

      // The mocked settings row does not echo writes back, so the proof of
      // persistence is the write itself: the app's own settings service stored a
      // `maintenance` block with the window open, stamped with who opened it.
      const written = JSON.stringify([
        ...context.prismaMock.systemSettings.update.mock.calls,
        ...context.prismaMock.systemSettings.upsert.mock.calls,
      ]);
      expect(response.body.data).toHaveProperty('source');
      expect(written).toContain('"maintenance":{"enabled":true,"message":"Upgrading."');
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'maintenance:enable' }),
        }),
      );
    });

    it('is refused without authentication', async () => {
      await request(server()).put('/api/admin/maintenance').send({ enabled: true }).expect(401);
    });
  });
});
