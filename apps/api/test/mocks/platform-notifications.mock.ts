/**
 * A stand-in for the platform `NotificationsService` (RETRO-D3, #576) for
 * producer unit tests, plus `calls()`: each recorded `notify*` call as one
 * object, with the event's registered browser template applied, so a spec can
 * assert the title the bell will show (`buildTitle(count)`) and the link.
 */
import '../../src/platform/notifications/notification.manifest';
import { renderBrowserNotification } from '../../src/notifications-registry/memoriahub.notifications';

export type NotifyMethod = 'notify' | 'notifyState' | 'notifyCounted' | 'notifyAddress' | 'notifyNow';

export interface RecordedNotification {
  method: NotifyMethod;
  eventKey: string;
  /** `userId` for every method but `notifyAddress`, where it is the address. */
  userId: string;
  data: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
  /** `options.scopeId` (the circle), or `undefined`. */
  circleId: unknown;
  windowMs: unknown;
  matchData: unknown;
  increment: unknown;
  /** The rendered title for `data` with `count` set. */
  buildTitle(count: number): string;
  /** The rendered link. */
  link: string | undefined;
  /** The rendered body. */
  body: string | undefined;
}

export function createPlatformNotificationsMock() {
  const mock = {
    notify: jest.fn().mockResolvedValue(undefined),
    notifyState: jest.fn().mockResolvedValue(undefined),
    notifyCounted: jest.fn().mockResolvedValue(undefined),
    notifyAddress: jest.fn().mockResolvedValue(undefined),
    notifyNow: jest.fn().mockResolvedValue({ rateLimited: false, retryAfterMs: null }),
    notifyPermissionHolders: jest.fn().mockResolvedValue(undefined),
    notifyPermissionHoldersNow: jest.fn().mockResolvedValue(undefined),
  };

  function calls(method: NotifyMethod): RecordedNotification[] {
    return (mock[method].mock.calls as unknown[][]).map(([eventKey, userId, data, options]) => {
      const payload = (data ?? {}) as Record<string, unknown>;
      const opts = options as Record<string, unknown> | undefined;
      const rendered = renderBrowserNotification(eventKey as string, payload);
      return {
        method,
        eventKey: eventKey as string,
        userId: userId as string,
        data: payload,
        options: opts,
        circleId: opts?.['scopeId'],
        windowMs: opts?.['windowMs'] ?? null,
        matchData: opts?.['match'],
        increment: opts?.['increment'],
        buildTitle: (count: number) => renderBrowserNotification(eventKey as string, { ...payload, count })?.title ?? '',
        link: rendered?.link,
        body: rendered?.body,
      };
    });
  }

  return { mock, calls };
}
