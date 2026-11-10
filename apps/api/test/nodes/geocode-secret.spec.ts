/**
 * The Google geocoding key reaches a worker node only through the platform's per-job secret
 * (RETRO-C6, #600), over the real HTTP stack with the real `GeocodeHandler` and its real
 * `GoogleGeocodeKeyBroker` in the real registry. The credential store and the settings document are
 * the only things stubbed.
 *
 *   - `POST /api/nodes/:id/jobs/:jobId/secret` returns `{ kind: 'geo.google', expiresAt, material: { apiKey } }`
 *     for a job the node holds under a live lease, bounded by that lease, and nothing else;
 *   - the `job_node_secrets` write carries the handle and never the key;
 *   - a stale claim token, an expired lease, another node's job and a job that is no longer running are
 *     refused with 409 and mint nothing;
 *   - with the `nodes.jobSecretBrokerEnabled` switch off (the default) the route is a 403 and `geocode` is
 *     withheld from the node claim, so the server runs the job; with a provider other than google (or no key)
 *     the broker is not usable: 503 with a remedy, and again `geocode` is not offered to nodes;
 *   - no log line, response body or write contains the key.
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { NodeOffloadService } from '@marinoscar/platform-api/jobs';
import { SECRET_CLOCK_SKEW_ALLOWANCE_MS } from '@marinoscar/platform-api/nodes';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { AppSystemSettingsService } from '../../src/platform/settings/app-system-settings.service';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';

/** Distinctive on purpose: greppable in any log or body. */
const FIXTURE_KEY = 'k-geo-must-never-be-logged-9f2c';
const NODE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '66666666-6666-4666-8666-666666666666';
const OTHER_TOKEN = '77777777-7777-4777-8777-777777777777';

describe('geocode: the Google key through the per-job secret (RETRO-C6)', () => {
  let context: TestContext;
  let geoSettings: Record<string, unknown>;
  let credentialStored: boolean;
  let logged: string[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    const credentials = context.module.get(CredentialsService, { strict: false });
    jest.spyOn(credentials, 'describe').mockImplementation(async () =>
      credentialStored ? ({ purpose: 'geo_provider', name: 'google', hint: '…9f2c' } as never) : null,
    );
    jest.spyOn(credentials, 'getSecret').mockImplementation(async () => (credentialStored ? FIXTURE_KEY : null));
    const appSettings = context.module.get(AppSystemSettingsService, { strict: false });
    jest.spyOn(appSettings, 'getSettings').mockImplementation(async () => ({ geo: geoSettings }) as never);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();
    geoSettings = { reverseProvider: 'google', google: { enabled: true } };
    credentialStored = true;
    (context.module.get(SystemSettingsService) as any).settingsCache = null;
    givenBrokerEnabled(true);
    (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mockResolvedValue({});

    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });

  const server = () => context.app.getHttpServer();
  const secretPath = `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/secret`;

  function givenBrokerEnabled(enabled: boolean): void {
    (context.prismaMock.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      id: 'settings-row',
      key: 'default',
      value: {
        nodes: { staleHeartbeatSeconds: 90, offlineStaleMultiplier: 4, offlineRetentionDays: 30, jobSecretBrokerEnabled: enabled },
      },
      version: 1,
      updatedByUserId: null,
      updatedAt: new Date(),
    });
  }

  function nodeRow(ownerId: string) {
    return {
      id: NODE_ID,
      name: 'worker-one',
      hostname: 'host-a.example.test',
      platform: 'linux',
      cliVersion: '2.0.0',
      eligibleTypes: ['geocode'],
      concurrency: 1,
      status: 'online',
      capabilities: null,
      registeredAt: new Date(),
      lastHeartbeatAt: null,
      createdById: ownerId,
    };
  }

  function jobRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      type: 'geocode',
      subjectType: 'media_item',
      subjectId: randomUUID(),
      dedupKey: null,
      status: 'running',
      reason: 'upload',
      priority: 0,
      providerKey: null,
      modelVersion: null,
      payload: null,
      attempts: 1,
      lastError: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      scheduledFor: null,
      rateLimitedAt: null,
      rateLimitHits: 0,
      claimedByNodeId: NODE_ID,
      claimToken: CLAIM_TOKEN,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      executor: 'node',
      orgId: null,
      ...overrides,
    };
  }

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

  function givenHeldJob(ownerId: string, overrides: Record<string, unknown> = {}): void {
    grant(ownerId, ['nodes:read', 'nodes:write']);
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(nodeRow(ownerId));
    (context.prismaMock.workerNode.findFirst as jest.Mock).mockResolvedValue(nodeRow(ownerId));
    (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow(overrides));
  }

  it('200 with { kind, expiresAt, material: { apiKey } } and nothing else, bounded by the lease', async () => {
    const admin = await createMockAdminUser(context);
    const leaseExpiresAt = new Date(Date.now() + 123_000);
    givenHeldJob(admin.id, { leaseExpiresAt });

    const response = await request(server())
      .post(secretPath)
      .set(authHeader(admin.accessToken))
      .send({ claimToken: CLAIM_TOKEN })
      .expect(200);

    expect(Object.keys(response.body.data).sort()).toEqual(['expiresAt', 'kind', 'material']);
    expect(response.body.data.kind).toBe('geo.google');
    expect(response.body.data.material).toEqual({ apiKey: FIXTURE_KEY });
    expect(response.body.data.expiresAt).toBe(new Date(leaseExpiresAt.getTime() + SECRET_CLOCK_SKEW_ALLOWANCE_MS).toISOString());
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data).not.toHaveProperty('handle');
  });

  it('records the handle in job_node_secrets and nothing that is the key', async () => {
    const admin = await createMockAdminUser(context);
    givenHeldJob(admin.id);

    await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200);

    const written = (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mock.calls[0][0];
    expect(written.where).toEqual({ jobId_kind: { jobId: JOB_ID, kind: 'geo.google' } });
    expect(written.create.handle).toBe(`geo-google-${JOB_ID}`);
    expect(JSON.stringify(written)).not.toContain(FIXTURE_KEY);
  });

  it('is re-callable for the same job: both calls land on the same grant', async () => {
    const admin = await createMockAdminUser(context);
    givenHeldJob(admin.id);

    await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200);
    await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200);

    const calls = (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].create.handle).toBe(calls[1][0].create.handle);
  });

  describe('refusals mint nothing', () => {
    const expectNoKeyMinted = (body: unknown) => {
      expect(JSON.stringify(body)).not.toContain(FIXTURE_KEY);
      expect(context.prismaMock.jobNodeSecret.upsert).not.toHaveBeenCalled();
    };

    it('409 for another node\'s job (a second node)', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { claimedByNodeId: 'some-other-node' });
      const res = await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(409);
      expectNoKeyMinted(res.body);
    });

    it('409 for a stale claim token', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);
      const res = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({ claimToken: OTHER_TOKEN })
        .expect(409);
      expect(res.body.details.reason).toBe('lease_not_held');
      expectNoKeyMinted(res.body);
    });

    it('409 once the lease has expired', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { leaseExpiresAt: new Date(Date.now() - 1_000) });
      const res = await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(409);
      expectNoKeyMinted(res.body);
    });

    it('409 for a job that has settled', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { status: 'succeeded', finishedAt: new Date() });
      const res = await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(409);
      expectNoKeyMinted(res.body);
    });

    it('403 with a named reason while the broker switch is off (the default)', async () => {
      const admin = await createMockAdminUser(context);
      givenBrokerEnabled(false);
      givenHeldJob(admin.id);
      const res = await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(403);
      expect(res.body.details.reason).toBe('job_secret_broker_disabled');
      expect(res.body.details.setting).toBe('nodes.jobSecretBrokerEnabled');
      expectNoKeyMinted(res.body);
    });

    it.each([
      ['the active provider is not google', () => { geoSettings = { reverseProvider: 'nominatim' }; }],
      ['the Google provider is switched off', () => { geoSettings = { reverseProvider: 'google', google: { enabled: false } }; }],
      ['no key is stored', () => { credentialStored = false; }],
    ])('503 with a remedy, and no key, when %s', async (_name, arrange) => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);
      arrange();
      const res = await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(503);
      expect(res.body.details.reason).toBe('broker_unusable');
      expect(res.body.details.remedy).toBeTruthy();
      expectNoKeyMinted(res.body);
    });
  });

  describe('what a node is offered', () => {
    const offered = () => context.module.get(NodeOffloadService).offeredTypes();

    it('offers geocode to nodes only with the broker switch on, a google provider and a stored key', async () => {
      givenBrokerEnabled(true);
      expect(await offered()).toContain('geocode');
    });

    it.each([
      ['the broker switch is off', () => givenBrokerEnabled(false)],
      ['the provider is not google', () => { geoSettings = { reverseProvider: 'offline' }; }],
      ['no key is stored', () => { credentialStored = false; }],
    ])('withholds geocode from nodes (the server runs it) when %s', async (_name, arrange) => {
      (context.module.get(SystemSettingsService) as any).settingsCache = null;
      arrange();
      const types = await offered();
      expect(types).not.toContain('geocode');
      expect(await context.module.get(NodeOffloadService).serverOnlyRightNow()).toContain('geocode');
    });
  });

  it('no log line contains the key, across every request above shape', async () => {
    const admin = await createMockAdminUser(context);
    givenHeldJob(admin.id);
    await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200);
    geoSettings = { reverseProvider: 'offline' };
    await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(503);

    expect(logged.join('\n')).not.toContain(FIXTURE_KEY);
  });
});
