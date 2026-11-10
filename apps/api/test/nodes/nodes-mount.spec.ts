/**
 * The platform nodes slice is mounted (RETRO-C2, #581).
 *
 * Boots the whole AppModule against the mocked Prisma client and checks the acceptance criteria that
 * need no database:
 *   - the platform serves `/api/nodes` (register, claim, ...), `/api/admin/nodes` and
 *     `/api/node-credentials`, and the app's copies are gone (no `jobs/:jobId/credentials` route);
 *   - a `Bearer nod_...` credential reaches the two app routes under `/api/nodes`
 *     (`GET /api/nodes/models/manifest`, `/api/nodes/:id/backup/*`) and is refused everywhere else
 *     (`/api/media`, `/api/system-settings`), even when its owner is an administrator;
 *   - the node is resolved by id AND the caller: another user's node answers 404 on a backup route;
 *   - `nodes:read` / `nodes:write` gate the app routes (a caller without them gets 403);
 *   - the nodes fleet jobs are registered, server-only, and the provider-key types are server-only;
 *   - the `nodes` settings namespace carries the legacy `NODE_*` values as defaults.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import {
  NODE_FLEET_PRUNE_TYPE,
  NODE_FLEET_SWEEP_TYPE,
  NODE_TOKEN_PREFIX,
} from '@marinoscar/platform-api/nodes';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { legacyNodesDefaults } from '../../src/app-registrations/settings';
import { PROVIDER_KEY_SERVER_ONLY_TYPES } from '../../src/platform/jobs/legacy-handlers.adapter';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('platform nodes slice mount (RETRO-C2)', () => {
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
    mockPrismaTransaction();
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

  /** An administrator who holds the node permissions, and a `nod_` credential of theirs. */
  async function adminWithNodeCredential(): Promise<{ userId: string; token: string }> {
    const admin = await createMockAdminUser(context);
    grant(admin.id, ['nodes:read', 'nodes:write']);
    const token = `${NODE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    const owner = await (context.prismaMock.user.findUnique as jest.Mock)({ where: { id: admin.id } });
    (context.prismaMock.nodeCredential.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args?.where?.tokenHash === sha256(token)
        ? {
            id: randomUUID(),
            userId: admin.id,
            name: 'fleet',
            tokenHash: sha256(token),
            tokenPrefix: token.slice(0, 8),
            revokedAt: null,
            expiresAt: null,
            lastUsedAt: null,
            createdAt: new Date(),
            user: owner,
          }
        : null,
    );
    (context.prismaMock.nodeCredential.update as jest.Mock).mockResolvedValue({});
    return { userId: admin.id, token };
  }

  const node = (id: string, createdById: string) => ({
    id,
    name: 'worker-one',
    hostname: 'host-a.example.test',
    platform: 'linux',
    cliVersion: '2.0.0',
    eligibleTypes: [],
    concurrency: 1,
    status: 'online',
    capabilities: null,
    registeredAt: new Date(),
    lastHeartbeatAt: new Date(),
    lastVitals: null,
    lastVitalsAt: null,
    createdById,
  });

  /** The worker_nodes table: a lookup honours the id and the owner it is given, as Postgres would. */
  function mockNodes(rows: Array<ReturnType<typeof node>>): void {
    (context.prismaMock.workerNode.findFirst as jest.Mock).mockImplementation(async (args: any) =>
      rows.find((row) => row.id === args?.where?.id && (!args.where.createdById || row.createdById === args.where.createdById)) ?? null,
    );
  }

  it('a nod_ credential reaches GET /api/nodes/models/manifest', async () => {
    const { token } = await adminWithNodeCredential();
    const res = await request(context.app.getHttpServer())
      .get('/api/nodes/models/manifest')
      .set(authHeader(token));
    expect(res.status).toBe(200);
    const manifest = res.body.data ?? res.body;
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest[0]).toMatchObject({ name: 'clip-vit-b32-vision-quantized.onnx', targetSubdir: '' });
  });

  it('the model manifest needs nodes:read', async () => {
    const viewer = await createMockViewerUser(context);
    const res = await request(context.app.getHttpServer())
      .get('/api/nodes/models/manifest')
      .set(authHeader(viewer.accessToken));
    expect(res.status).toBe(403);
  });

  it('a nod_ credential reaches /api/nodes/:id/backup/config of its owner node', async () => {
    const { userId, token } = await adminWithNodeCredential();
    const nodeId = randomUUID();
    mockNodes([node(nodeId, userId)]);
    (context.prismaMock.nodeBackupConfig.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(context.app.getHttpServer())
      .get(`/api/nodes/${nodeId}/backup/config`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect((res.body.data ?? res.body).config).toBeNull();
  });

  it("another user's node answers 404 on a backup route, never 403", async () => {
    const { token } = await adminWithNodeCredential();
    const nodeId = randomUUID();
    mockNodes([node(nodeId, randomUUID())]);

    const res = await request(context.app.getHttpServer())
      .get(`/api/nodes/${nodeId}/backup/config`)
      .set(authHeader(token));

    expect(res.status).toBe(404);
  });

  it('an unknown node answers 404 on a backup route', async () => {
    const { token } = await adminWithNodeCredential();
    mockNodes([]);
    const res = await request(context.app.getHttpServer())
      .get(`/api/nodes/${randomUUID()}/backup/config`)
      .set(authHeader(token));
    expect(res.status).toBe(404);
  });

  it.each(['/api/media', '/api/system-settings', '/api/users', '/api/admin/jobs'])(
    'a nod_ credential is refused on %s, even for an administrator owner',
    async (path) => {
      const { token } = await adminWithNodeCredential();
      const res = await request(context.app.getHttpServer()).get(path).set(authHeader(token));
      expect([401, 403]).toContain(res.status);
    },
  );

  it('a revoked or unknown nod_ credential is a 401', async () => {
    await adminWithNodeCredential();
    const res = await request(context.app.getHttpServer())
      .get('/api/nodes/models/manifest')
      .set(authHeader(`${NODE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`));
    expect(res.status).toBe(401);
  });

  it('mounts the platform control plane (register is the slice\'s: a bad body is a 400, not a 404)', async () => {
    const { token } = await adminWithNodeCredential();
    const res = await request(context.app.getHttpServer())
      .post('/api/nodes/register')
      .set(authHeader(token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('no route issues a provider credential to a node: jobs/:jobId/credentials is gone', async () => {
    const { token } = await adminWithNodeCredential();
    const res = await request(context.app.getHttpServer())
      .post(`/api/nodes/${randomUUID()}/jobs/${randomUUID()}/credentials`)
      .set(authHeader(token))
      .send({});
    expect(res.status).toBe(404);
  });

  it('registers the fleet jobs server-only, and keeps the provider-key types server-only', () => {
    const registry = context.module.get(JobHandlerRegistry);
    const serverOnly = registry.serverOnlyTypes();
    expect(registry.types()).toEqual(expect.arrayContaining([NODE_FLEET_SWEEP_TYPE, NODE_FLEET_PRUNE_TYPE]));
    expect(serverOnly).toEqual(expect.arrayContaining([NODE_FLEET_SWEEP_TYPE, NODE_FLEET_PRUNE_TYPE]));
    for (const type of PROVIDER_KEY_SERVER_ONLY_TYPES) {
      expect(registry.types()).toContain(type);
      expect(serverOnly).toContain(type);
    }
  });

  it('keeps the legacy NODE_* values as the defaults of the nodes namespace', () => {
    expect(legacyNodesDefaults({} as NodeJS.ProcessEnv)).toEqual({
      staleHeartbeatSeconds: 60,
      offlineStaleMultiplier: 10,
      offlineRetentionDays: 14,
    });
    expect(
      legacyNodesDefaults({
        NODE_HEARTBEAT_STALE_SECONDS: '120',
        NODE_OFFLINE_STALE_MULTIPLIER: '3',
        NODE_OFFLINE_RETENTION_DAYS: '30',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ staleHeartbeatSeconds: 120, offlineStaleMultiplier: 3, offlineRetentionDays: 30 });
    expect(legacyNodesDefaults({ NODE_OFFLINE_RETENTION_DAYS: 'soon' } as unknown as NodeJS.ProcessEnv).offlineRetentionDays).toBe(14);
  });
});
