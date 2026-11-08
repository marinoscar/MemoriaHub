import request from 'supertest';
import { randomUUID } from 'crypto';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockViewerUser } from '../helpers/auth-mock.helper';

// =============================================================================
// The device flow the Android pairing and the CLI use (RETRO-B2, issue #611)
// =============================================================================
//
// The flow is the identity slice's. These specs pin the MemoriaHub contract on
// top of it: `clientInfo.returnUri` (`memoriahub:` deep links, `https:`) survives
// issuance and is echoed to the activation page, an unsafe scheme is refused,
// `clientInfo.name` is accepted, and `nod_` credentials stay confined to
// /api/nodes while `pat_` tokens are accepted everywhere.

describe('device flow (identity slice)', () => {
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
  });

  function server() {
    return context.app.getHttpServer();
  }

  it('issues a code and stores clientInfo.returnUri and the client name for a pairing', async () => {
    context.prismaMock.deviceCode.create.mockImplementation(async ({ data }: any) => ({
      id: randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const response = await request(server())
      .post('/api/auth/device/code')
      .send({ clientInfo: { tokenType: 'pat', name: 'Pixel 8', returnUri: 'memoriahub://pairing' } })
      .expect(200);

    expect(response.body.data.userCode).toBeTruthy();
    const stored = context.prismaMock.deviceCode.create.mock.calls[0][0].data.clientInfo;
    expect(stored).toMatchObject({ tokenType: 'pat', returnUri: 'memoriahub://pairing' });
    // The deprecated `name` alias is the device name (and so the PAT's name).
    expect(stored.deviceName).toBe('Pixel 8');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://evil.example.test/'])(
    'refuses the return URI %s',
    async (returnUri) => {
      const response = await request(server())
        .post('/api/auth/device/code')
        .send({ clientInfo: { tokenType: 'pat', returnUri } })
        .expect(400);
      expect(JSON.stringify(response.body)).toContain('INVALID_RETURN_URI');
      expect(context.prismaMock.deviceCode.create).not.toHaveBeenCalled();
    },
  );

  it('accepts an https return URI', async () => {
    context.prismaMock.deviceCode.create.mockImplementation(async ({ data }: any) => ({
      id: randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await request(server())
      .post('/api/auth/device/code')
      .send({ clientInfo: { tokenType: 'pat', returnUri: 'https://app.example.test/paired' } })
      .expect(200);
  });

  it('echoes the stored returnUri on the activation lookup', async () => {
    context.prismaMock.deviceCode.findUnique.mockResolvedValue({
      id: randomUUID(),
      deviceCode: 'hash',
      userCode: 'ABCD1234',
      status: 'pending',
      userId: null,
      clientInfo: { tokenType: 'pat', deviceName: 'Pixel 8', returnUri: 'memoriahub://pairing' },
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    const user = await createMockViewerUser(context);

    const response = await request(server())
      .get('/api/auth/device/activate?code=ABCD1234')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data.clientInfo.returnUri).toBe('memoriahub://pairing');
  });

  it('refuses a nod_ credential outside /api/nodes (it never reaches media or settings)', async () => {
    await request(server()).get('/api/media-sync/devices').set(authHeader('nod_0123456789abcdef')).expect(403);
  });
});
