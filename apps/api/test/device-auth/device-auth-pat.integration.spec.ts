/**
 * Device flow → personal access token, end to end over HTTP (issue #499).
 *
 * The unit tests in `src/device-auth/__tests__/device-auth.service.spec.ts`
 * call `DeviceAuthService` directly with `clientInfo.tokenType: 'pat'`, so they
 * never pass through the global `ZodValidationPipe`. That pipe STRIPS keys the
 * `ClientInfoSchema` does not list — which is exactly how `tokenType` and
 * `name` used to vanish before reaching the service, silently turning every
 * CLI login into a 7-day JWT session.
 *
 * This suite therefore drives the real app (real controller, real pipe, real
 * guard, real service) through Supertest. Only Prisma is replaced, by a small
 * in-memory `device_codes` / `personal_access_tokens` store, so what the
 * service persists in step 1 is exactly what it reads back in step 3.
 */
import request from 'supertest';
import { DeviceCodeStatus } from '@prisma/client';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  authHeader,
  TestUser,
} from '../helpers/auth-mock.helper';

interface StoredDeviceCode {
  id: string;
  deviceCode: string;
  userCode: string;
  userId: string | null;
  status: DeviceCodeStatus;
  clientInfo: Record<string, unknown>;
  scopes: string[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredPat {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  durationValue: number;
  durationUnit: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

describe('Device flow → PAT over HTTP (issue #499)', () => {
  let context: TestContext;
  let user: TestUser;
  let deviceCodes: StoredDeviceCode[];
  let pats: StoredPat[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    user = await createMockTestUser(context);
    deviceCodes = [];
    pats = [];

    const prisma = context.prismaMock;

    prisma.deviceCode.create.mockImplementation(async ({ data }: any) => {
      const row: StoredDeviceCode = {
        id: `dc-${deviceCodes.length + 1}`,
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        userId: null,
        status: data.status,
        // Deep copy: prove the persisted JSON, not a live reference.
        clientInfo: JSON.parse(JSON.stringify(data.clientInfo ?? {})),
        scopes: data.scopes ?? [],
        expiresAt: data.expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      deviceCodes.push(row);
      return row;
    });

    prisma.deviceCode.findUnique.mockImplementation(
      async ({ where, include }: any) => {
        const row = deviceCodes.find(
          (r) =>
            (where.deviceCode !== undefined &&
              r.deviceCode === where.deviceCode) ||
            (where.userCode !== undefined && r.userCode === where.userCode) ||
            (where.id !== undefined && r.id === where.id),
        );
        if (!row) return null;
        if (!include?.user) return { ...row };
        const owner = row.userId
          ? await prisma.user.findUnique({
              where: { id: row.userId },
              include: { userRoles: { include: { role: true } } },
            })
          : null;
        return { ...row, user: owner };
      },
    );

    prisma.deviceCode.update.mockImplementation(
      async ({ where, data }: any) => {
        const row = deviceCodes.find((r) => r.id === where.id);
        if (!row) throw new Error(`deviceCode ${where.id} not found`);
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    );

    prisma.personalAccessToken.create.mockImplementation(
      async ({ data }: any) => {
        const row: StoredPat = {
          id: `pat-${pats.length + 1}`,
          lastUsedAt: null,
          createdAt: new Date(),
          revokedAt: null,
          ...data,
        };
        pats.push(row);
        return row;
      },
    );
  });

  const server = () => context.app.getHttpServer();

  /** Run code → authorize → token and return the token response body. */
  async function runFlow(clientInfo?: Record<string, unknown>) {
    const codeRes = await request(server())
      .post('/api/auth/device/code')
      .send(clientInfo === undefined ? {} : { clientInfo })
      .expect(200);
    const { deviceCode, userCode } = codeRes.body.data;

    await request(server())
      .post('/api/auth/device/authorize')
      .set(authHeader(user.accessToken))
      .send({ userCode, approve: true })
      .expect(200);

    const tokenRes = await request(server())
      .post('/api/auth/device/token')
      .send({ deviceCode })
      .expect(200);

    return tokenRes.body.data;
  }

  it('tokenType "pat" survives the validation pipe and yields a pat_ token', async () => {
    const data = await runFlow({
      tokenType: 'pat',
      name: 'x',
      hostname: 'oscar-laptop',
      platform: 'linux',
    });

    expect(data.accessToken).toMatch(/^pat_[0-9a-f]{64}$/);
    expect(data.credentialType).toBe('pat');
    expect(data.refreshToken).toBe('');
    expect(data.tokenType).toBe('Bearer');
    expect(data.tokenName).toBe('x');
    expect(data.tokenId).toBe('pat-1');
    expect(typeof data.expiresAt).toBe('string');

    // A personal_access_tokens row named "x" exists for the approving user.
    expect(pats).toHaveLength(1);
    expect(pats[0]).toMatchObject({ name: 'x', userId: user.id });

    // The stored DeviceCode.clientInfo kept the allowlisted fields.
    expect(deviceCodes).toHaveLength(1);
    expect(deviceCodes[0].clientInfo).toEqual({
      tokenType: 'pat',
      name: 'x',
      hostname: 'oscar-laptop',
      platform: 'linux',
    });
    // Single use: the code is burned once the PAT is collected.
    expect(deviceCodes[0].status).toBe(DeviceCodeStatus.expired);
  });

  it('trims the name and still strips keys outside the allowlist', async () => {
    await runFlow({
      tokenType: 'pat',
      name: '  MemoriaHub Android · Pixel 8  ',
      isAdmin: true,
      scopes: ['everything'],
    });

    expect(deviceCodes[0].clientInfo).toEqual({
      tokenType: 'pat',
      name: 'MemoriaHub Android · Pixel 8',
    });
    expect(pats[0].name).toBe('MemoriaHub Android · Pixel 8');
  });

  it('shows name and tokenType on the activation lookup', async () => {
    const codeRes = await request(server())
      .post('/api/auth/device/code')
      .send({ clientInfo: { tokenType: 'pat', name: 'MemoriaHub CLI' } })
      .expect(200);

    const res = await request(server())
      .get('/api/auth/device/activate')
      .query({ code: codeRes.body.data.userCode })
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(res.body.data.clientInfo).toMatchObject({
      tokenType: 'pat',
      name: 'MemoriaHub CLI',
    });
  });

  it('without tokenType the response is still a session token', async () => {
    const data = await runFlow({ deviceName: 'Living room TV' });

    expect(data.accessToken).not.toMatch(/^pat_/);
    expect(data.accessToken.split('.')).toHaveLength(3); // a JWT
    expect(typeof data.refreshToken).toBe('string');
    expect(data.refreshToken.length).toBeGreaterThan(0);
    expect(data.credentialType).toBe('session');
    expect(pats).toHaveLength(0);
  });

  it('a bodyless code request is still a session token', async () => {
    const data = await runFlow();

    expect(data.accessToken).not.toMatch(/^pat_/);
    expect(data.credentialType).toBe('session');
    expect(pats).toHaveLength(0);
  });

  it('tokenType "session" explicitly is a session token', async () => {
    const data = await runFlow({ tokenType: 'session', name: 'browser' });

    expect(data.accessToken).not.toMatch(/^pat_/);
    expect(data.credentialType).toBe('session');
    expect(pats).toHaveLength(0);
  });

  it.each([['PAT'], ['admin'], [''], [1]])(
    'rejects an unknown tokenType %p with 400 and stores nothing',
    async (tokenType) => {
      await request(server())
        .post('/api/auth/device/code')
        .send({ clientInfo: { tokenType, name: 'x' } })
        .expect(400);

      expect(deviceCodes).toHaveLength(0);
    },
  );

  it('rejects an over-long name with 400', async () => {
    await request(server())
      .post('/api/auth/device/code')
      .send({ clientInfo: { tokenType: 'pat', name: 'n'.repeat(101) } })
      .expect(400);

    expect(deviceCodes).toHaveLength(0);
  });
});
