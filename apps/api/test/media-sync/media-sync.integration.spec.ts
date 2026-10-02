/**
 * Media Sync device API through the real HTTP stack (issue #505).
 *
 * The app boots with the mocked Prisma client; the media-sync tables, the
 * personal access tokens and the circle memberships are backed by a small
 * in-memory store below, so a request flows through the real guards
 * (JwtAuthGuard's PAT branch included), the real Zod validation, the real
 * service and the real HttpExceptionFilter.
 *
 * The phone's PAT is minted by the real `PatService.createToken`, the method
 * the device flow (#499) calls on approval, so the raw `pat_` token, its hash
 * and its row are exactly what a paired phone would hold.
 */
import request from 'supertest';
import { randomUUID } from 'crypto';

import { PatService } from '../../src/pat/pat.service';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  TestUser,
  authHeader,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'NOT') return !matches(row, value);
    return row[key] === value;
  });
}

const INVENTORY = [
  { bucketId: '111', name: 'Camera', relativePath: 'DCIM/Camera/', photoCount: 10, videoCount: 2, bytes: 5000 },
  { bucketId: '222', name: 'Screenshots', relativePath: 'Pictures/Screenshots/', photoCount: 3, videoCount: 0, bytes: 900 },
];

const STATS = {
  eligible: 12,
  uploaded: 6,
  deduplicated: 1,
  pending: 2,
  uploading: 1,
  failed: 1,
  blocked: 1,
  bytesPending: 1000,
  bytesUploaded: 4000,
};

describe('Media Sync device API (integration)', () => {
  let context: TestContext;
  let server: any;

  // In-memory backing store.
  let devices: Row[];
  let runs: Row[];
  let reports: Row[];
  let pats: Map<string, Row>; // by tokenHash
  let circles: Row[];
  let members: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    server = context.app.getHttpServer();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    devices = [];
    runs = [];
    reports = [];
    pats = new Map();
    circles = [];
    members = [];
    const m = context.prismaMock;

    // --- personal access tokens ---------------------------------------------
    m.personalAccessToken.create.mockImplementation(async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...data };
      pats.set(row.tokenHash, row);
      return row;
    });
    m.personalAccessToken.findUnique.mockImplementation(async ({ where }: any) => {
      const row = pats.get(where.tokenHash);
      if (!row) return null;
      const user = await m.user.findUnique({ where: { id: row.userId } });
      return { ...row, user };
    });
    m.personalAccessToken.update.mockResolvedValue({});
    m.personalAccessToken.updateMany.mockImplementation(async ({ where, data }: any) => {
      let count = 0;
      for (const row of pats.values()) {
        if (row.id === where.id && row.userId === where.userId && row.revokedAt === null) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    });

    // --- circles --------------------------------------------------------------
    m.circle.findFirst.mockImplementation(async ({ where }: any) =>
      circles.find((c) => c.ownerId === where.ownerId && c.isPersonal === where.isPersonal) ?? null,
    );
    m.circle.findUnique.mockImplementation(async ({ where }: any) => circles.find((c) => c.id === where.id) ?? null);
    m.circleMember.findUnique.mockImplementation(
      async ({ where }: any) =>
        members.find(
          (x) => x.circleId === where.circleId_userId.circleId && x.userId === where.circleId_userId.userId,
        ) ?? null,
    );
    m.circleMember.findFirst.mockResolvedValue(null);

    // --- media sync devices -------------------------------------------------------
    const withPat = (row: Row) => {
      const linked = [...pats.values()].find((p) => p.id === row.patId);
      return { ...row, pat: linked ? { expiresAt: linked.expiresAt, revokedAt: linked.revokedAt } : null };
    };
    m.mediaSyncDevice.findUnique.mockImplementation(async ({ where }: any) => {
      const key = where.userId_installationId;
      const row = devices.find((d) => d.userId === key.userId && d.installationId === key.installationId);
      return row ? { patId: row.patId } : null;
    });
    m.mediaSyncDevice.findFirst.mockImplementation(async ({ where, include }: any) => {
      const row = devices.find((d) => matches(d, where));
      if (!row) return null;
      return include ? withPat(row) : { id: row.id };
    });
    m.mediaSyncDevice.findMany.mockImplementation(async ({ where }: any) =>
      devices.filter((d) => matches(d, where)).map(withPat),
    );
    m.mediaSyncDevice.findUniqueOrThrow.mockImplementation(async ({ where }: any) => {
      const row = devices.find((d) => d.id === where.id);
      if (!row) throw new Error('not found');
      return { ...row };
    });
    m.mediaSyncDevice.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const key = where.userId_installationId;
      let row: Row | undefined = devices.find((d) => d.userId === key.userId && d.installationId === key.installationId);
      if (row) {
        Object.assign(row, update, { updatedAt: new Date() });
      } else {
        row = {
          id: randomUUID(),
          configVersion: 1,
          appliedConfigVersion: 0,
          inventory: null,
          stats: null,
          permission: null,
          networkState: null,
          batteryOptimized: null,
          lastSyncAt: null,
          lastSyncStatus: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        devices.push(row as Row);
      }
      return withPat(row as Row);
    });
    m.mediaSyncDevice.updateMany.mockImplementation(async ({ where, data }: any) => {
      let count = 0;
      for (const row of devices) {
        if (!matches(row, where)) continue;
        Object.assign(row, data);
        count++;
      }
      return { count };
    });
    m.mediaSyncDevice.update.mockImplementation(async ({ where, data }: any) => {
      const row = devices.find((d) => d.id === where.id)!;
      Object.assign(row, data);
      return row;
    });

    // --- runs and reports -------------------------------------------------------
    m.mediaSyncRun.create.mockImplementation(async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), details: null, ...data };
      runs.push(row);
      return row;
    });
    m.mediaSyncRun.findMany.mockImplementation(async ({ where, take }: any) =>
      runs.filter((r) => r.deviceId === where.deviceId).reverse().slice(0, take),
    );
    m.mediaSyncDiagnosticReport.create.mockImplementation(async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), ...data };
      reports.push(row);
      return { id: row.id, createdAt: row.createdAt };
    });
    m.mediaSyncDiagnosticReport.findMany.mockImplementation(async ({ where, take }: any) =>
      reports.filter((r) => r.deviceId === where.deviceId).reverse().slice(0, take),
    );
    m.mediaSyncDiagnosticReport.findFirst.mockImplementation(
      async ({ where }: any) => reports.find((r) => r.id === where.id && r.deviceId === where.deviceId) ?? null,
    );

    m.androidAppRelease.findFirst.mockResolvedValue(null);
    m.auditEvent.create.mockResolvedValue({});
    m.$executeRaw.mockResolvedValue(0);
  });

  /** A signed-in user with a personal circle (circle_admin there). */
  async function userWithCircle(kind: 'contributor' | 'viewer' = 'contributor'): Promise<TestUser & { circleId: string }> {
    const user = kind === 'viewer' ? await createMockViewerUser(context) : await createMockContributorUser(context);
    const circleId = randomUUID();
    circles.push({ id: circleId, ownerId: user.id, isPersonal: true });
    members.push({ circleId, userId: user.id, role: 'circle_admin' });
    return { ...user, circleId };
  }

  /** Mints a pat_ token for the user exactly as the device flow does. */
  async function mintPat(userId: string): Promise<string> {
    const patService = context.module.get(PatService);
    const { token } = await patService.createToken(userId, {
      name: 'MemoriaHub Android · Pixel 9',
      durationValue: 90,
      durationUnit: 'days',
    } as any);
    return token;
  }

  function register(token: string, installationId = randomUUID()) {
    return request(server)
      .post('/api/media-sync/devices')
      .set(authHeader(token))
      .send({ installationId, name: 'Pixel 9', model: 'Pixel 9', appVersionCode: 1, packageName: 'memoriahub.marin.cr' });
  }

  function checkin(token: string, deviceId: string, body: Record<string, unknown> = {}) {
    return request(server)
      .post(`/api/media-sync/devices/${deviceId}/checkin`)
      .set(authHeader(token))
      .send({
        appliedConfigVersion: 1,
        stats: STATS,
        permission: 'full',
        networkState: 'wifi',
        batteryOptimized: false,
        ...body,
      });
  }

  it('register → check-in → PATCH config with the JWT → the next check-in returns the new config', async () => {
    const user = await userWithCircle();
    const phone = await mintPat(user.id);

    const reg = await register(phone).expect(201);
    const device = reg.body.data;
    expect(device).toMatchObject({
      status: 'active',
      configVersion: 1,
      appliedConfigVersion: 0,
      configPending: true,
      config: { targetCircleId: user.circleId, folders: [], network: 'wifi', paused: false },
    });
    expect(device.tokenExpiresAt).toEqual(expect.any(String));

    const first = await checkin(phone, device.id, { inventory: INVENTORY }).expect(200);
    expect(first.body.data).toMatchObject({ configVersion: 1, config: { folders: [] } });
    expect(first.body.data.serverTime).toEqual(expect.any(String));

    const patched = await request(server)
      .patch(`/api/media-sync/devices/${device.id}/config`)
      .set(authHeader(user.accessToken))
      .send({ folders: [{ bucketId: '111', name: 'ignored' }], network: 'any' })
      .expect(200);
    expect(patched.body.data).toEqual({
      configVersion: 2,
      config: expect.objectContaining({ folders: [{ bucketId: '111', name: 'Camera' }], network: 'any' }),
    });

    const next = await checkin(phone, device.id).expect(200);
    expect(next.body.data).toMatchObject({
      configVersion: 2,
      config: { folders: [{ bucketId: '111', name: 'Camera' }], network: 'any' },
    });

    const view = await request(server).get(`/api/media-sync/devices/${device.id}`).set(authHeader(user.accessToken)).expect(200);
    expect(view.body.data).toMatchObject({ configPending: true, appliedConfigVersion: 1, stats: STATS });
  });

  it("PATCH config with the device's own PAT works, inventory included", async () => {
    const user = await userWithCircle();
    const phone = await mintPat(user.id);
    const device = (await register(phone).expect(201)).body.data;

    const res = await request(server)
      .patch(`/api/media-sync/devices/${device.id}/config`)
      .set(authHeader(phone))
      .send({ inventory: INVENTORY, folders: [{ bucketId: '222', name: 'x' }] })
      .expect(200);

    expect(res.body.data.config.folders).toEqual([{ bucketId: '222', name: 'Screenshots' }]);
  });

  it('re-registering is a 200 and revokes the previous PAT', async () => {
    const user = await userWithCircle();
    const installationId = randomUUID();
    const oldPat = await mintPat(user.id);
    await register(oldPat, installationId).expect(201);

    const newPat = await mintPat(user.id);
    await register(newPat, installationId).expect(200);

    await request(server).get('/api/media-sync/devices').set(authHeader(oldPat)).expect(401);
    await request(server).get('/api/media-sync/devices').set(authHeader(newPat)).expect(200);
  });

  it('refuses registration with a session token (400 PAT_REQUIRED in details.reason)', async () => {
    const user = await userWithCircle();
    const res = await register(user.accessToken).expect(400);
    expect(res.body.details).toMatchObject({ reason: 'PAT_REQUIRED' });
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('commands bump configVersion and are visible to the phone', async () => {
    const user = await userWithCircle();
    const phone = await mintPat(user.id);
    const device = (await register(phone).expect(201)).body.data;

    const paused = await request(server)
      .post(`/api/media-sync/devices/${device.id}/commands`)
      .set(authHeader(user.accessToken))
      .send({ action: 'pause' })
      .expect(200);
    expect(paused.body.data).toMatchObject({ configVersion: 2, config: { paused: true } });

    await request(server)
      .post(`/api/media-sync/devices/${device.id}/commands`)
      .set(authHeader(phone))
      .send({ action: 'sync_now' })
      .expect(200);

    const next = await checkin(phone, device.id).expect(200);
    expect(next.body.data).toMatchObject({ configVersion: 3, config: { paused: true, syncNowGeneration: 1 } });
  });

  it('stores runs and diagnostics and serves them back', async () => {
    const user = await userWithCircle();
    const phone = await mintPat(user.id);
    const device = (await register(phone).expect(201)).body.data;

    await checkin(phone, device.id, {
      run: {
        trigger: 'manual',
        status: 'ok',
        startedAt: '2026-10-02T10:00:00Z',
        finishedAt: '2026-10-02T10:01:00Z',
        filesUploaded: 3,
        bytesUploaded: 123456,
        filesFailed: 0,
        filesDeduplicated: 1,
      },
    }).expect(200);

    const list = await request(server).get(`/api/media-sync/devices/${device.id}/runs`).set(authHeader(user.accessToken)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ trigger: 'manual', status: 'ok', bytesUploaded: '123456' });

    const created = await request(server)
      .post(`/api/media-sync/devices/${device.id}/diagnostics`)
      .set(authHeader(phone))
      .send({ summary: 'All checks pass', report: { checks: [{ id: 'auth.valid', status: 'pass' }] } })
      .expect(201);
    const reportId = created.body.data.id;

    const one = await request(server)
      .get(`/api/media-sync/devices/${device.id}/diagnostics/${reportId}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(one.body.data).toMatchObject({ summary: 'All checks pass', report: { checks: [{ id: 'auth.valid' }] } });
  });

  it('PATCH config errors carry details.reason', async () => {
    const user = await userWithCircle();
    const phone = await mintPat(user.id);
    const device = (await register(phone).expect(201)).body.data;
    const url = `/api/media-sync/devices/${device.id}/config`;

    const unknown = await request(server).patch(url).set(authHeader(user.accessToken)).send({ folders: [{ bucketId: '9', name: 'n' }] }).expect(400);
    expect(unknown.body.details).toEqual({ reason: 'UNKNOWN_FOLDER', bucketIds: ['9'] });

    const inv = await request(server).patch(url).set(authHeader(user.accessToken)).send({ inventory: INVENTORY }).expect(400);
    expect(inv.body.details).toEqual({ reason: 'INVENTORY_NOT_ALLOWED' });

    const foreignCircle = randomUUID();
    circles.push({ id: foreignCircle, ownerId: randomUUID(), isPersonal: false });
    const forbidden = await request(server).patch(url).set(authHeader(user.accessToken)).send({ targetCircleId: foreignCircle }).expect(403);
    expect(forbidden.body.details).toEqual({ reason: 'TARGET_CIRCLE_FORBIDDEN', circleId: foreignCircle });

    await request(server).patch(url).set(authHeader(user.accessToken)).send({ paused: true }).expect(400);
  });

  it('unpair revokes the device and its PAT; the PAT stops authenticating', async () => {
    const user = await userWithCircle();
    const phone = await mintPat(user.id);
    const device = (await register(phone).expect(201)).body.data;

    await request(server).delete(`/api/media-sync/devices/${device.id}`).set(authHeader(user.accessToken)).expect(204);

    await checkin(phone, device.id).expect(401);
    const view = await request(server).get(`/api/media-sync/devices/${device.id}`).set(authHeader(user.accessToken)).expect(200);
    expect(view.body.data).toMatchObject({ status: 'revoked', tokenExpiresAt: null });
  });

  describe('RBAC and scoping', () => {
    it('requires authentication', async () => {
      await request(server).get('/api/media-sync/devices').expect(401);
    });

    it('a caller without media:write gets 403 on writes but may read', async () => {
      const viewer = await userWithCircle('viewer');
      const viewerPat = await mintPat(viewer.id);

      await register(viewerPat).expect(403);
      await request(server).get('/api/media-sync/devices').set(authHeader(viewer.accessToken)).expect(200);
    });

    it("another user's device is a 404 everywhere", async () => {
      const owner = await userWithCircle();
      const phone = await mintPat(owner.id);
      const device = (await register(phone).expect(201)).body.data;
      const stranger = await userWithCircle();
      const auth = authHeader(stranger.accessToken);

      await request(server).get(`/api/media-sync/devices/${device.id}`).set(auth).expect(404);
      await request(server).get(`/api/media-sync/devices/${device.id}/runs`).set(auth).expect(404);
      await request(server).patch(`/api/media-sync/devices/${device.id}/config`).set(auth).send({ network: 'any' }).expect(404);
      await request(server).post(`/api/media-sync/devices/${device.id}/commands`).set(auth).send({ action: 'pause' }).expect(404);
      await request(server).delete(`/api/media-sync/devices/${device.id}`).set(auth).expect(404);
      const list = await request(server).get('/api/media-sync/devices').set(auth).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it("a PAT linked to device A gets 404 on device B's config, commands and check-in", async () => {
      const user = await userWithCircle();
      const patA = await mintPat(user.id);
      const patB = await mintPat(user.id);
      await register(patA).expect(201);
      const deviceB = (await register(patB).expect(201)).body.data;

      await request(server).patch(`/api/media-sync/devices/${deviceB.id}/config`).set(authHeader(patA)).send({ network: 'any' }).expect(404);
      await request(server).post(`/api/media-sync/devices/${deviceB.id}/commands`).set(authHeader(patA)).send({ action: 'pause' }).expect(404);
      await checkin(patA, deviceB.id).expect(404);
      await request(server)
        .post(`/api/media-sync/devices/${deviceB.id}/diagnostics`)
        .set(authHeader(patA))
        .send({ report: {} })
        .expect(404);
    });

    it('a check-in with a session token is 400 PAT_REQUIRED', async () => {
      const user = await userWithCircle();
      const phone = await mintPat(user.id);
      const device = (await register(phone).expect(201)).body.data;

      const res = await checkin(user.accessToken, device.id).expect(400);
      expect(res.body.details).toEqual({ reason: 'PAT_REQUIRED' });
    });
  });

  it('POST /api/media with a foreign sourceDeviceId is 400 UNKNOWN_SOURCE_DEVICE', async () => {
    const owner = await userWithCircle();
    const ownerPat = await mintPat(owner.id);
    const ownersDevice = (await register(ownerPat).expect(201)).body.data;

    const uploader = await userWithCircle();
    const storageObjectId = randomUUID();
    context.prismaMock.storageObject.findUnique.mockResolvedValue({
      id: storageObjectId,
      uploadedById: uploader.id,
      storageKey: 'k',
    });
    context.prismaMock.mediaItem.findUnique.mockResolvedValue(null);

    const res = await request(server)
      .post('/api/media')
      .set(authHeader(uploader.accessToken))
      .send({
        storageObjectId,
        circleId: uploader.circleId,
        type: 'photo',
        source: 'android',
        originalFilename: 'IMG_1.jpg',
        sourceDeviceId: ownersDevice.id,
      })
      .expect(400);

    expect(res.body.details).toEqual({ reason: 'UNKNOWN_SOURCE_DEVICE' });
    expect(context.prismaMock.mediaItem.create).not.toHaveBeenCalled();
  });
});
