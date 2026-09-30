import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';

import {
  HEARTBEAT_INTERVAL_MS,
  MAX_CONNECTIONS_PER_USER,
  NotificationStreamService,
  SseMessage,
} from './notification-stream.service';
import { NotificationDispatchedEvent } from './notification-dispatch.service';

function makeEvent(userId: string, over: Partial<NotificationDispatchedEvent> = {}): NotificationDispatchedEvent {
  return {
    userId,
    reason: 'created',
    pushed: false,
    toast: true,
    notification: {
      id: 'n-1',
      circleId: null,
      type: 'upload_completed',
      title: 'Done',
      body: null,
      link: '/',
      data: null,
      readAt: null,
      dismissedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    ...over,
  };
}

describe('NotificationStreamService (#485)', () => {
  let notifications: { getUnreadCount: jest.Mock };
  let service: NotificationStreamService;

  beforeEach(() => {
    notifications = { getUnreadCount: jest.fn().mockResolvedValue({ count: 4 }) };
    service = new NotificationStreamService(notifications as never);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  function collect(userId: string): { frames: SseMessage[]; unsubscribe: () => void } {
    const frames: SseMessage[] = [];
    const sub = service.subscribe(userId).subscribe((m) => frames.push(m));
    return { frames, unsubscribe: () => sub.unsubscribe() };
  }

  it('sends a connected comment first, registers, and cleans up on unsubscribe', async () => {
    const first = await firstValueFrom(service.subscribe('u1').pipe(take(1)));
    expect(first).toEqual({ type: 'ping', data: { type: 'ping' } });

    const c = collect('u1');
    expect(service.connectionCount('u1')).toBe(1);
    expect(service.connectionCount()).toBe(1);
    c.unsubscribe();
    expect(service.connectionCount('u1')).toBe(0);
    expect(service.connectionCount()).toBe(0);
  });

  it('is cold: an Observable nobody subscribes to registers nothing', () => {
    service.subscribe('u1');
    expect(service.connectionCount('u1')).toBe(0);
  });

  it('sends a heartbeat comment every interval and stops after unsubscribe', () => {
    jest.useFakeTimers();
    const c = collect('u1');
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    // 1 on open + 2 heartbeats
    expect(c.frames.filter((f) => f.type === 'ping')).toHaveLength(3);
    c.unsubscribe();
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(c.frames.filter((f) => f.type === 'ping')).toHaveLength(3);
  });

  it('publishes only to the target user (per-user isolation)', () => {
    const a1 = collect('a');
    const a2 = collect('a');
    const b = collect('b');
    expect(service.publish('a', { type: 'sync', data: { type: 'sync' } })).toBe(2);
    expect(a1.frames).toContainEqual({ type: 'sync', data: { type: 'sync' } });
    expect(a2.frames).toContainEqual({ type: 'sync', data: { type: 'sync' } });
    expect(b.frames).toEqual([{ type: 'ping', data: { type: 'ping' } }]);
  });

  it('publish is a no-op with no connection', () => {
    expect(service.publish('nobody', { type: 'sync', data: {} })).toBe(0);
    expect(service.publishSync('nobody')).toBe(0);
  });

  it('caps connections per user by completing the oldest', () => {
    let firstCompleted = false;
    service.subscribe('u').subscribe({ complete: () => (firstCompleted = true) });
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) collect('u');
    expect(service.connectionCount('u')).toBe(MAX_CONNECTIONS_PER_USER);
    expect(firstCompleted).toBe(true);
  });

  it('turns notification.dispatched into a notification frame with the unread count', async () => {
    const c = collect('u1');
    await service.onDispatched(makeEvent('u1', { pushed: true, reason: 'incremented' }));
    expect(c.frames[1]).toEqual({
      type: 'notification',
      data: {
        type: 'notification',
        notification: expect.objectContaining({ id: 'n-1' }),
        unreadCount: 4,
        toast: true,
        pushed: true,
        reason: 'incremented',
      },
    });
  });

  it('does no I/O when the user has no open connection', async () => {
    await service.onDispatched(makeEvent('offline'));
    expect(notifications.getUnreadCount).not.toHaveBeenCalled();
  });

  it('omits unreadCount (still publishes) when the count read fails, and never throws', async () => {
    notifications.getUnreadCount.mockRejectedValue(new Error('db down'));
    const c = collect('u1');
    await expect(service.onDispatched(makeEvent('u1'))).resolves.toBeUndefined();
    expect(c.frames[1].data).not.toHaveProperty('unreadCount');
  });

  it('completes every stream on module destroy', async () => {
    const done = firstValueFrom(service.subscribe('u1').pipe(toArray()));
    service.onModuleDestroy();
    await expect(done).resolves.toEqual([{ type: 'ping', data: { type: 'ping' } }]);
    expect(service.connectionCount()).toBe(0);
  });
});
