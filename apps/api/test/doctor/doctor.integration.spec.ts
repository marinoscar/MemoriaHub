import request from 'supertest';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import {
  TestContext,
  closeTestApp,
  createTestApp,
} from '../helpers/test-app.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

/**
 * The platform Doctor as MemoriaHub mounts it (RETRO-B1b, #602): every check is
 * registered after `app.init()`, the route is `system_settings:read`-gated, the
 * old `POST /api/admin/doctor/run` is gone, and the support bundle carries no
 * secret.
 */

/**
 * The 27 app checks (the 35 documented ones minus the 3 the host core and the 2 the jobs slice
 * retired, `core.pg-client-version`, replaced by the db-backup slice's `backup.pg-client`, and the
 * two storage checks the storage slice's `storage.config` / `storage.bucket` replace, RETRO-D1).
 */
const MEMORIAHUB_CHECK_IDS = [
  'memoriahub.core.pgvector',
  'memoriahub.core.app-url',
  'memoriahub.auth.jwt',
  'memoriahub.auth.google-oauth',
  'memoriahub.auth.admin-bootstrap',
  'memoriahub.ai.search',
  'memoriahub.ai.tagging',
  'memoriahub.ai.embedding',
  'memoriahub.ai.flag-consistency',
  'memoriahub.ai.social-media',
  'memoriahub.ai.duplicate-detection',
  'memoriahub.ai.picture-enhancer',
  'memoriahub.ai.video-tagging',
  'memoriahub.face.detection',
  'memoriahub.face.flag-consistency',
  'memoriahub.face.pgvector',
  'memoriahub.geo.reverse-provider',
  'memoriahub.jobs.burst-config',
  'memoriahub.nodes.registered-count',
  'memoriahub.nodes.heartbeat-freshness',
  'memoriahub.nodes.stale-leases',
  'memoriahub.nodes.capability-health',
  'memoriahub.workflows.state',
  'memoriahub.android.assetlinks',
  'memoriahub.android.releases',
  'memoriahub.android.media-sync',
  'memoriahub.android.upload-path',
];

/** The platform checks that replace the three retired app checks. */
const PLATFORM_REPLACEMENT_IDS = [
  'db.connection',
  'db.migrations',
  'secrets.encryption-key',
  // The jobs slice (RETRO-C1) replaces memoriahub.jobs.worker-enabled and memoriahub.jobs.queue-health.
  'jobs.worker',
  'jobs.backlog',
  // The db-backup slice (RETRO-D4) replaces memoriahub.core.pg-client-version, and adds its own three.
  'backup.pg-client',
  'backup.schedule',
  'backup.rls-bypass',
  'backup.mirrors',
  // The storage slice (RETRO-D1) replaces memoriahub.storage.active-provider and memoriahub.storage.live-test.
  'storage.config',
  'storage.bucket',
];

/** The telemetry slice's five checks (RETRO-T2, #625), under the `telemetry` category. */
const TELEMETRY_CHECK_IDS = [
  'telemetry.export',
  'telemetry.connection',
  'telemetry.reachable',
  'telemetry.tables',
  'telemetry.freshness',
];

describe('Platform Doctor (Integration)', () => {
  let context: TestContext;
  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  });

  it('registers all 27 memoriahub checks plus the platform replacements after app.init()', () => {
    const ids = context.module.get(DoctorCheckRegistry).list().map((check) => check.id);

    for (const id of [...MEMORIAHUB_CHECK_IDS, ...PLATFORM_REPLACEMENT_IDS, ...TELEMETRY_CHECK_IDS]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every check read-only by id shape: lower-case dotted ids', () => {
    for (const check of context.module.get(DoctorCheckRegistry).list()) {
      expect(check.id).toMatch(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/);
    }
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(server()).get('/api/admin/doctor').expect(401);
  });

  it('rejects a caller without system_settings:read with 403', async () => {
    const viewer = await createMockViewerUser(context);
    await request(server()).get('/api/admin/doctor').set(authHeader(viewer.accessToken)).expect(403);
  });

  it('serves the report to an admin, with the app checks grouped under their categories', async () => {
    const admin = await createMockAdminUser(context);
    const response = await request(server())
      .get('/api/admin/doctor')
      .set(authHeader(admin.accessToken))
      .expect(200);

    const report = response.body.data;
    const checks = JSON.stringify(report);
    for (const id of MEMORIAHUB_CHECK_IDS) expect(checks).toContain(id);
    for (const id of TELEMETRY_CHECK_IDS) expect(checks).toContain(id);
    for (const category of ['core', 'auth', 'storage', 'ai', 'face', 'geo', 'jobs', 'nodes', 'workflows', 'android', 'telemetry']) {
      expect(checks).toContain(`"${category}"`);
    }
  });

  it('no longer serves POST /api/admin/doctor/run', async () => {
    const admin = await createMockAdminUser(context);
    await request(server())
      .post('/api/admin/doctor/run')
      .set(authHeader(admin.accessToken))
      .expect(404);
  });

  it('downloads a support bundle for an admin that carries no secret material', async () => {
    const admin = await createMockAdminUser(context);
    const response = await request(server())
      .get('/api/admin/doctor/support-bundle')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.headers['content-disposition']).toContain('support-bundle-memoriahub-');
    const text = JSON.stringify(response.body) + (response.text ?? '');
    expect(text).not.toContain(process.env.JWT_SECRET ?? 'jwt-secret-never-present');
    expect(text).not.toContain(process.env.SECRETS_ENCRYPTION_KEY ?? 'key-never-present');
  });
});
