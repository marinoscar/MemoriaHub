/** PushTestService (epic #481, issue #483) — diagnostics + endpoint bookkeeping. */
import * as webpush from 'web-push';
import { WebPushError } from 'web-push';

import {
  isValidVapidPublicKey,
  isValidVapidSubject,
  privateKeyDerivesPublicKey,
  PushTestService,
} from './push-test.service';

jest.mock('web-push', () => {
  const actual = jest.requireActual('web-push');
  return { ...actual, sendNotification: jest.fn() };
});

const send = webpush.sendNotification as jest.Mock;
const KEYS = jest.requireActual('web-push').generateVAPIDKeys();

function sub(id: string, endpoint: string) {
  return {
    id,
    userId: 'u1',
    endpoint,
    p256dh: 'p',
    auth: 'a',
    userAgent: 'ua',
    failureCount: 2,
    lastSuccessAt: null,
    createdAt: new Date(0),
  };
}

function build(opts: { active?: boolean; subs?: any[]; row?: unknown } = {}) {
  const active =
    opts.active === false
      ? null
      : { publicKey: KEYS.publicKey, privateKey: KEYS.privateKey, subject: 'mailto:ops@example.com' };
  const prisma = {
    systemSettings: {
      findUnique: jest.fn().mockResolvedValue(
        opts.row === undefined ? { value: { enabled: true } } : opts.row,
      ),
    },
    pushSubscription: {
      findMany: jest.fn().mockResolvedValue(opts.subs ?? []),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const pushConfig = { resolveActiveVapidConfig: jest.fn().mockResolvedValue(active) };
  return { service: new PushTestService(prisma as any, pushConfig as any), prisma };
}

describe('PushTestService', () => {
  beforeEach(() => send.mockReset());

  it('reports not_configured with no row and sends nothing', async () => {
    const { service } = build({ active: false, row: null, subs: [sub('s1', 'https://fcm.googleapis.com/x')] });
    const res = await service.runTest('u1', {});
    expect(res.overall).toBe('not_configured');
    expect(res.config.source).toBe('none');
    expect(res.subscriptions[0].result.status).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect(res.hints.join(' ')).toMatch(/not configured/);
  });

  it('reports no_subscriptions when active but the caller has none', async () => {
    const { service } = build();
    const res = await service.runTest('u1', {});
    expect(res.overall).toBe('no_subscriptions');
    expect(res.config).toMatchObject({ active: true, publicKeyValid: true, privateKeyMatchesPublicKey: true });
  });

  it('only loads the CALLER\'s subscriptions', async () => {
    const { service, prisma } = build();
    await service.runTest('caller', {});
    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'caller' } }),
    );
  });

  it('sends with per-call vapidDetails and a timeout; records success', async () => {
    send.mockResolvedValue({ statusCode: 201 });
    const s = sub('s1', 'https://fcm.googleapis.com/abcdefghijkl');
    const { service, prisma } = build({ subs: [s] });
    const res = await service.runTest('u1', { endpoint: s.endpoint, applicationServerKey: KEYS.publicKey });
    expect(res.overall).toBe('sent');
    expect(res.browser).toEqual({ endpointProvided: true, endpointRegistered: true, keyMatchesServer: true });
    const [, , options] = send.mock.calls[0];
    expect(options).toMatchObject({ timeout: 10_000, vapidDetails: { publicKey: KEYS.publicKey } });
    expect(prisma.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({ failureCount: 0 }),
    });
    expect(res.subscriptions[0].endpointPreview).toBe('fcm.googleapis.com/…efghijkl');
  });

  it('prunes on 410, reports others as failed without bumping failureCount', async () => {
    send
      .mockRejectedValueOnce(new WebPushError('gone', 410, {}, '', 'https://a.example/1'))
      .mockRejectedValueOnce(new WebPushError('denied', 403, {}, 'bad jwt', 'https://b.example/2'));
    const { service, prisma } = build({
      subs: [sub('s1', 'https://a.example/1'), sub('s2', 'https://b.example/2')],
    });
    const res = await service.runTest('u1', {});
    expect(res.overall).toBe('failed');
    expect(res.subscriptions.map((s) => s.result.status)).toEqual(['pruned', 'failed']);
    expect(res.subscriptions[1].result.responseBody).toBe('bad jwt');
    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(prisma.pushSubscription.update).not.toHaveBeenCalled();
  });

  it('never leaks the private key, subscription keys, or a full endpoint', async () => {
    send.mockResolvedValue({ statusCode: 201 });
    const endpoint = 'https://fcm.googleapis.com/secret-endpoint-token-123';
    const { service } = build({ subs: [sub('s1', endpoint)] });
    const json = JSON.stringify(await service.runTest('u1', {}));
    expect(json).not.toContain(KEYS.privateKey);
    expect(json).not.toContain(endpoint);
  });

  it('audits counts and hosts only', async () => {
    const { service, prisma } = build();
    await service.runTest('u1', {});
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'push_config:test' }) }),
    );
  });

  describe('pure helpers', () => {
    it('validates keys and subjects', () => {
      expect(isValidVapidPublicKey(KEYS.publicKey)).toBe(true);
      expect(isValidVapidPublicKey('nope')).toBe(false);
      expect(privateKeyDerivesPublicKey(KEYS.privateKey, KEYS.publicKey)).toBe(true);
      expect(privateKeyDerivesPublicKey('AAAA', KEYS.publicKey)).toBe(false);
      expect(isValidVapidSubject('mailto:a@b.co')).toBe(true);
      expect(isValidVapidSubject('https://example.com')).toBe(true);
      expect(isValidVapidSubject('http://example.com')).toBe(false);
    });
  });
});
