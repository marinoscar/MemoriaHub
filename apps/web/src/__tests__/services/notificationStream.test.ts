/**
 * Issue #485 — `services/notificationStream.ts`: the URL, the frame-name
 * filter, and frame-data validation. `connectSse` is mocked so the wiring is
 * verified without a network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SseFrame, SseOptions } from '../../services/sse';

const connectSseMock = vi.fn();

vi.mock('../../services/sse', async () => {
  const actual = await vi.importActual<typeof import('../../services/sse')>(
    '../../services/sse',
  );
  return { ...actual, connectSse: (options: SseOptions) => connectSseMock(options) };
});

const getAccessTokenMock = vi.fn<() => string | null>();
const refreshTokenMock = vi.fn<() => Promise<boolean>>();

vi.mock('../../services/api', () => ({
  api: {
    getAccessToken: () => getAccessTokenMock(),
    refreshToken: () => refreshTokenMock(),
  },
}));

import {
  connectNotificationStream,
  parseNotificationEvent,
  NOTIFICATION_SSE_EVENT,
  NOTIFICATION_STREAM_URL,
} from '../../services/notificationStream';

const row = {
  id: 'n1',
  circleId: 'circle-1',
  type: 'upload_completed',
  title: '3 items uploaded',
  body: null,
  link: '/',
  data: { count: 3 },
  readAt: null,
  dismissedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const frame = (payload: unknown, event = NOTIFICATION_SSE_EVENT): SseFrame => ({
  event,
  data: typeof payload === 'string' ? payload : JSON.stringify(payload),
  id: null,
});

describe('parseNotificationEvent', () => {
  it('parses the enveloped notification frame', () => {
    const result = parseNotificationEvent(
      JSON.stringify({ type: 'notification', notification: row, toast: true, pushed: true, reason: 'created' }),
    );
    expect(result).toEqual({
      type: 'notification',
      notification: row,
      toast: true,
      pushed: true,
      reason: 'created',
    });
  });

  it('defaults toast and pushed to false and reason to null when absent', () => {
    const result = parseNotificationEvent(JSON.stringify({ type: 'notification', notification: row }));
    expect(result).toMatchObject({ toast: false, pushed: false, reason: null });
  });

  it('only a literal true counts as toast/pushed', () => {
    const result = parseNotificationEvent(
      JSON.stringify({ type: 'notification', notification: row, toast: 'yes', pushed: 1 }),
    );
    expect(result).toMatchObject({ toast: false, pushed: false });
  });

  it('normalises missing optional row fields', () => {
    const { body: _b, readAt: _r, dismissedAt: _d, updatedAt: _u, data: _data, ...bare } = row;
    const result = parseNotificationEvent(JSON.stringify({ notification: bare, toast: true }));
    expect(result).toMatchObject({
      type: 'notification',
      notification: { body: null, readAt: null, dismissedAt: null, data: null, updatedAt: row.createdAt },
    });
  });

  it('keeps a valid unreadCount and drops an invalid one', () => {
    const ok = parseNotificationEvent(JSON.stringify({ notification: row, unreadCount: 4 }));
    expect(ok).toMatchObject({ unreadCount: 4 });
    for (const bad of [-1, 1.5, '4', null]) {
      const r = parseNotificationEvent(JSON.stringify({ notification: row, unreadCount: bad }));
      expect(r).not.toHaveProperty('unreadCount');
    }
  });

  it('parses a sync frame', () => {
    expect(parseNotificationEvent(JSON.stringify({ type: 'sync' }))).toEqual({ type: 'sync' });
  });

  it.each([
    ['not JSON', '{nope'],
    ['a scalar', '42'],
    ['null', 'null'],
    ['a row with no id', JSON.stringify({ notification: { ...row, id: undefined } })],
    ['a row with a numeric title', JSON.stringify({ notification: { ...row, title: 7 } })],
    ['a row with an undefined link', JSON.stringify({ notification: { ...row, link: undefined } })],
    ['an unknown envelope type', JSON.stringify({ type: 'other', notification: row })],
  ])('returns null for %s', (_label, data) => {
    expect(parseNotificationEvent(data)).toBeNull();
  });
});

describe('connectNotificationStream', () => {
  beforeEach(() => {
    connectSseMock.mockReset();
    connectSseMock.mockReturnValue({ close: vi.fn() });
    getAccessTokenMock.mockReset();
    refreshTokenMock.mockReset();
  });

  function connect() {
    const handlers = { onEvent: vi.fn(), onOpen: vi.fn(), onStateChange: vi.fn() };
    connectNotificationStream(handlers);
    const options = connectSseMock.mock.calls[0][0] as SseOptions;
    return { handlers, options };
  }

  it('connects to the stream URL', () => {
    const { options } = connect();
    expect(options.url).toBe(NOTIFICATION_STREAM_URL);
    expect(NOTIFICATION_STREAM_URL).toMatch(/\/notifications\/stream$/);
  });

  it('reads the bearer token fresh on every attempt, never in the URL', () => {
    const { options } = connect();
    getAccessTokenMock.mockReturnValueOnce('tok-1').mockReturnValueOnce(null);
    expect(options.authorization()).toBe('Bearer tok-1');
    expect(options.authorization()).toBeNull();
    expect(options.url).not.toContain('token');
  });

  it('renews credentials through api.refreshToken', async () => {
    refreshTokenMock.mockResolvedValue(true);
    const { options } = connect();
    await expect(options.reauthenticate()).resolves.toBe(true);
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it('passes onOpen and onStateChange straight through', () => {
    const { handlers, options } = connect();
    expect(options.onOpen).toBe(handlers.onOpen);
    expect(options.onStateChange).toBe(handlers.onStateChange);
  });

  it('delivers a well-formed notification frame', () => {
    const { handlers, options } = connect();
    options.onFrame(frame({ type: 'notification', notification: row, toast: true }));
    expect(handlers.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notification', toast: true, notification: row }),
    );
  });

  it('delivers a sync for a `sync`-named frame', () => {
    const { handlers, options } = connect();
    options.onFrame(frame('{}', 'sync'));
    expect(handlers.onEvent).toHaveBeenCalledWith({ type: 'sync' });
  });

  it('ignores frames with another name and drops malformed ones', () => {
    const { handlers, options } = connect();
    options.onFrame(frame({ notification: row }, 'ping'));
    options.onFrame(frame({ notification: row }, 'message'));
    options.onFrame(frame('not json'));
    expect(handlers.onEvent).not.toHaveBeenCalled();
  });
});
