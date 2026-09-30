/** NotificationDispatchService (epic #481, issue #484). */
import { Notification } from '@prisma/client';

import {
  NOTIFICATION_DISPATCHED_EVENT,
  NotificationDispatchService,
  PUSH_THROTTLE_MS,
} from './notification-dispatch.service';
import { DEFAULT_NOTIFICATION_POLICY } from './notification-policy.service';

const VAPID = { publicKey: 'P', privateKey: 'K', subject: 'mailto:a@example.com' };

function row(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    userId: 'u-1',
    circleId: null,
    type: 'upload_completed',
    title: 't',
    body: null,
    link: '/',
    data: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Notification;
}

function build(opts: { policy?: any; pushPref?: boolean; subs?: number; vapid?: any; sent?: boolean } = {}) {
  const prisma = {
    pushSubscription: { count: jest.fn().mockResolvedValue(opts.subs ?? 1) },
    notificationDelivery: {
      create: jest.fn().mockResolvedValue({ id: 'd-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const policy = { getPolicy: jest.fn().mockResolvedValue(opts.policy ?? DEFAULT_NOTIFICATION_POLICY) };
  const preferences = { isPushEnabled: jest.fn().mockResolvedValue(opts.pushPref ?? true) };
  const pushConfig = {
    resolveActiveVapidConfig: jest.fn().mockResolvedValue(opts.vapid === undefined ? VAPID : opts.vapid),
  };
  const sent = opts.sent ?? true;
  const channel = {
    deliver: jest.fn().mockResolvedValue({
      success: sent,
      attempted: 1,
      sent: sent ? 1 : 0,
      failed: sent ? 0 : 1,
      pruned: 0,
      error: sent ? null : 'Push failed for all 1 subscription(s) (0 pruned)',
    }),
  };
  const events = { emit: jest.fn() };
  const svc = new NotificationDispatchService(
    prisma as any,
    policy as any,
    preferences as any,
    pushConfig as any,
    channel as any,
    events as any,
  );
  return { svc, prisma, policy, preferences, pushConfig, channel, events };
}

describe('NotificationDispatchService', () => {
  it('pushes, records a delivery row queued → sent, and publishes the event', async () => {
    const t = build();
    t.svc.dispatch(row(), 'created');
    await t.svc.drain();

    expect(t.channel.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'n-1' }), VAPID);
    expect(t.prisma.notificationDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          notificationId: 'n-1',
          userId: 'u-1',
          type: 'upload_completed',
          channel: 'push',
          status: 'queued',
        },
      }),
    );
    expect(t.prisma.notificationDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd-1' }, data: expect.objectContaining({ status: 'sent', error: null }) }),
    );
    expect(t.events.emit).toHaveBeenCalledWith(
      NOTIFICATION_DISPATCHED_EVENT,
      expect.objectContaining({
        userId: 'u-1',
        reason: 'created',
        pushed: true,
        toast: true,
        notification: expect.objectContaining({ id: 'n-1', createdAt: new Date(0).toISOString() }),
      }),
    );
  });

  it('records a failed delivery with the error summary', async () => {
    const t = build({ sent: false });
    t.svc.dispatch(row());
    await t.svc.drain();
    expect(t.prisma.notificationDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', error: expect.stringMatching(/Push failed/) }) }),
    );
    expect(t.events.emit.mock.calls[0][1].pushed).toBe(false);
  });

  it.each([
    ['admin pushEnabled=false', { policy: { ...DEFAULT_NOTIFICATION_POLICY, pushEnabled: false } }],
    ['admin disabledTypes', { policy: { ...DEFAULT_NOTIFICATION_POLICY, disabledTypes: ['upload_completed'] } }],
    ['user push preference off', { pushPref: false }],
    ['no active VAPID', { vapid: null }],
    ['no subscriptions', { subs: 0 }],
  ])('does not push (and writes no delivery row) when %s', async (_label, opts) => {
    const t = build(opts as any);
    t.svc.dispatch(row());
    await t.svc.drain();
    expect(t.channel.deliver).not.toHaveBeenCalled();
    expect(t.prisma.notificationDelivery.create).not.toHaveBeenCalled();
    // The SSE event still fires so an open tab can update its inbox.
    expect(t.events.emit).toHaveBeenCalledTimes(1);
    expect(t.events.emit.mock.calls[0][1].pushed).toBe(false);
  });

  it('reports toast=false when the browser kill switch is off', async () => {
    const t = build({ policy: { ...DEFAULT_NOTIFICATION_POLICY, browserEnabled: false } });
    t.svc.dispatch(row());
    await t.svc.drain();
    expect(t.events.emit.mock.calls[0][1]).toMatchObject({ toast: false, pushed: true });
  });

  it('throttles to one push per notification id per 5 minutes', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const t = build();
      for (let i = 0; i < 50; i++) t.svc.dispatch(row(), 'incremented');
      await t.svc.drain();
      expect(t.channel.deliver).toHaveBeenCalledTimes(1);

      t.svc.dispatch(row({ id: 'n-2' }));
      await t.svc.drain();
      expect(t.channel.deliver).toHaveBeenCalledTimes(2);

      jest.setSystemTime(1_000_000 + PUSH_THROTTLE_MS + 1);
      t.svc.dispatch(row(), 'incremented');
      await t.svc.drain();
      expect(t.channel.deliver).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never throws or rejects, even when every dependency fails', async () => {
    const t = build();
    t.policy.getPolicy.mockRejectedValue(new Error('boom'));
    expect(() => t.svc.dispatch(row())).not.toThrow();
    await expect(t.svc.drain()).resolves.toBeUndefined();

    const t2 = build();
    t2.channel.deliver.mockRejectedValue(new Error('boom'));
    t2.events.emit.mockImplementation(() => {
      throw new Error('listener');
    });
    expect(() => t2.svc.dispatch(row())).not.toThrow();
    await expect(t2.svc.drain()).resolves.toBeUndefined();
  });

  it('a delivery-row write failure does not stop the push', async () => {
    const t = build();
    t.prisma.notificationDelivery.create.mockRejectedValue(new Error('db'));
    t.svc.dispatch(row());
    await t.svc.drain();
    expect(t.channel.deliver).toHaveBeenCalled();
    expect(t.prisma.notificationDelivery.update).not.toHaveBeenCalled();
  });

  it('works without an EventEmitter2', async () => {
    const t = build();
    const svc = new NotificationDispatchService(
      t.prisma as any,
      t.policy as any,
      t.preferences as any,
      t.pushConfig as any,
      t.channel as any,
    );
    svc.dispatch(row());
    await expect(svc.drain()).resolves.toBeUndefined();
  });

  it('onModuleDestroy drains in-flight dispatches', async () => {
    const t = build();
    let release!: () => void;
    t.channel.deliver.mockImplementation(
      () => new Promise((r) => (release = () => r({ success: true, attempted: 1, sent: 1, failed: 0, pruned: 0, error: null }))),
    );
    t.svc.dispatch(row());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const destroyed = t.svc.onModuleDestroy();
    release();
    await destroyed;
    expect(t.prisma.notificationDelivery.update).toHaveBeenCalled();
  });

  it('hasActivePushSubscription is false on error', async () => {
    const t = build();
    t.prisma.pushSubscription.count.mockRejectedValueOnce(new Error('x'));
    await expect(t.svc.hasActivePushSubscription('u')).resolves.toBe(false);
  });
});
