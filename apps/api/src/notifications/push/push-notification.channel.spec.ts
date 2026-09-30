/** PushNotificationChannel (epic #481, issue #484). */
import * as webpush from 'web-push';
import { WebPushError } from 'web-push';

import {
  MAX_PUSH_FAILURE_COUNT,
  PUSH_TTL_SECONDS,
  PushNotificationChannel,
  buildPushPayload,
  sanitizePushLink,
} from './push-notification.channel';

jest.mock('web-push', () => {
  const actual = jest.requireActual('web-push');
  return { ...actual, sendNotification: jest.fn() };
});
const send = webpush.sendNotification as jest.Mock;

const VAPID = { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:ops@example.com' };
const ROW = {
  id: 'n-1',
  userId: 'u-1',
  type: 'upload_completed' as const,
  title: '3 items uploaded',
  body: 'to Family',
  link: '/',
  circleId: 'c-1',
};

function sub(id: string, failureCount = 0) {
  return { id, userId: 'u-1', endpoint: `https://push.example/${id}`, p256dh: 'p', auth: 'a', failureCount };
}

function build(subs: any[], active: any = VAPID) {
  const prisma = {
    pushSubscription: {
      findMany: jest.fn().mockResolvedValue(subs),
      update: jest.fn(async ({ where, data }: any) => {
        const s = subs.find((x) => x.id === where.id);
        if (data.failureCount?.increment) s.failureCount += data.failureCount.increment;
        return { failureCount: s.failureCount };
      }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const pushConfig = { resolveActiveVapidConfig: jest.fn().mockResolvedValue(active) };
  return { channel: new PushNotificationChannel(prisma as any, pushConfig as any), prisma, pushConfig };
}

describe('sanitizePushLink / buildPushPayload', () => {
  it('keeps root-relative links, falls back for anything else', () => {
    expect(sanitizePushLink('/bursts?x=1')).toBe('/bursts?x=1');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil', 'javascript:alert(1)', 'rel/path', '/a\u0000b']) {
      expect(sanitizePushLink(bad as any)).toBe('/notifications');
    }
  });

  it('builds the payload with tag = id, icon/badge, and truncation', () => {
    const p = buildPushPayload({ ...ROW, title: 'x'.repeat(500), body: null, link: '//evil' });
    expect(p).toMatchObject({
      id: 'n-1',
      tag: 'n-1',
      type: 'upload_completed',
      circleId: 'c-1',
      link: '/notifications',
      body: '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
    });
    expect(p.title.length).toBe(200);
  });
});

describe('PushNotificationChannel.deliver', () => {
  beforeEach(() => send.mockReset());

  it('reports not-configured without sending', async () => {
    const { channel } = build([sub('s1')], null);
    const r = await channel.deliver(ROW);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports no subscriptions', async () => {
    const { channel } = build([]);
    const r = await channel.deliver(ROW, VAPID);
    expect(r).toMatchObject({ success: false, attempted: 0 });
  });

  it('sends with per-call vapidDetails and TTL; success resets failureCount', async () => {
    send.mockResolvedValue({ statusCode: 201 });
    const { channel, prisma } = build([sub('s1', 3)]);
    const r = await channel.deliver(ROW, VAPID);
    expect(r).toMatchObject({ success: true, sent: 1, attempted: 1 });
    const [target, payload, options] = send.mock.calls[0];
    expect(target).toEqual({ endpoint: 'https://push.example/s1', keys: { p256dh: 'p', auth: 'a' } });
    expect(JSON.parse(payload)).toMatchObject({ id: 'n-1', tag: 'n-1', link: '/' });
    expect(options).toMatchObject({
      TTL: PUSH_TTL_SECONDS,
      vapidDetails: { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:ops@example.com' },
    });
    expect(prisma.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({ failureCount: 0 }),
    });
  });

  it('prunes 404/410 immediately and counts others toward the threshold', async () => {
    send
      .mockRejectedValueOnce(new WebPushError('gone', 410, {}, '', 'e'))
      .mockRejectedValueOnce(new WebPushError('busy', 503, {}, '', 'e'))
      .mockRejectedValueOnce(new WebPushError('busy', 429, {}, '', 'e'))
      .mockResolvedValueOnce({ statusCode: 201 });
    const subs = [sub('gone'), sub('flaky', 0), sub('dying', MAX_PUSH_FAILURE_COUNT - 1), sub('ok')];
    const { channel, prisma } = build(subs);
    const r = await channel.deliver(ROW, VAPID);
    expect(r).toMatchObject({ success: true, attempted: 4, sent: 1, failed: 2, pruned: 2 });
    const deleted = prisma.pushSubscription.delete.mock.calls.map((c: any) => c[0].where.id).sort();
    expect(deleted).toEqual(['dying', 'gone']);
  });

  it('never throws — an unexpected error becomes a failed result', async () => {
    const { channel, prisma } = build([sub('s1')]);
    prisma.pushSubscription.findMany.mockRejectedValueOnce(new Error('db down'));
    const r = await channel.deliver(ROW, VAPID);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/db down/);
  });

  it('all endpoints failing is a failed result with a counts-only summary', async () => {
    send.mockRejectedValue(new WebPushError('busy', 500, {}, 'secret body', 'e'));
    const { channel } = build([sub('s1'), sub('s2')]);
    const r = await channel.deliver(ROW, VAPID);
    expect(r.success).toBe(false);
    expect(r.error).toBe('Push failed for all 2 subscription(s) (0 pruned)');
  });
});
