/**
 * The notification stream — `GET /api/notifications/stream`, over the
 * fetch-based SSE client (issue #485, epic #481; ported from EnterpriseAppBase).
 *
 * Thin by design: SSE framing, reconnection and backoff live in
 * `services/sse.ts`; what a notification IS lives in `types/notifications.ts`.
 * What is left here is what is specific to this one stream — its URL, its
 * frame name, and how a frame's `data` becomes something the store can hold.
 *
 * =============================================================================
 * THE STREAM IS NOT A DELIVERY GUARANTEE
 * =============================================================================
 *
 * There is no replay: anything published while this connection is down is
 * never seen by this tab, and the API's stream registry is per process, so
 * with several API replicas a tab can miss events even while connected. The
 * `notifications` TABLE is the source of truth, so:
 *
 *   * the caller MUST refetch the unread count (and any loaded list) on EVERY
 *     `onOpen` — the first connect and every reconnect — see
 *     `hooks/useNotifications.ts`;
 *   * a missed frame is a missing TOAST, never a missing notification.
 */

import { api } from './api';
import { connectSse, type SseConnection, type SseState } from './sse';
import type { NotificationItem, NotificationStreamEvent } from '../types/notifications';

/**
 * The `event:` name the API publishes notifications under. MUST MATCH the
 * server's constant in `notification-stream.service.ts` — a mismatch fails
 * silently (frames arrive, nothing matches, the bell never updates live).
 */
export const NOTIFICATION_SSE_EVENT = 'notification';

/**
 * A frame name the server MAY use to say "re-read everything" (for example
 * after a bulk mutation a single row cannot describe). A `{ type: 'sync' }`
 * payload under the `notification` name means the same thing.
 */
export const NOTIFICATION_SYNC_EVENT = 'sync';

const API_BASE_URL =import.meta.env.VITE_API_BASE_URL || '/api';

/** The stream's URL, resolved against the same base as every other API call. */
export const NOTIFICATION_STREAM_URL = `${API_BASE_URL}/notifications/stream`;

function isNotificationItem(value: unknown): value is NotificationItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === 'string';
  return (
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.createdAt === 'string' &&
    nullableString(v.circleId) &&
    nullableString(v.link) &&
    // `body` / `readAt` may be absent on an older or trimmed payload; they are
    // normalised below rather than rejected.
    (v.body === undefined || nullableString(v.body)) &&
    (v.readAt === undefined || nullableString(v.readAt))
  );
}

/**
 * Parse one frame's `data` into a stream event, or `null` if it is not one.
 *
 * VALIDATED, NOT CAST: the payload arrived over a socket, and a malformed or
 * truncated frame must cost one live update — never the read loop, and never a
 * row rendered with `undefined` as its title. Returns `null` rather than
 * throwing for the same reason.
 *
 * `unreadCount` is kept only when it is a non-negative integer.
 * `toast` defaults to `false` when absent (never raise an OS toast the server
 * did not ask for) and `pushed` to `false` (which keeps the page's own toast —
 * the fail-safe direction).
 */
export function parseNotificationEvent(data: string): NotificationStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;

  if (value.type === 'sync') return { type: 'sync' };

  // Accept both the enveloped shape (`{ type, notification, toast, ... }`) and a
  // bare row, so a server that flattens the payload later does not go dark.
  const candidate = 'notification' in value ? value.notification : value;
  if (value.type !== undefined && value.type !== 'notification' && 'notification' in value) {
    return null;
  }
  if (!isNotificationItem(candidate)) return null;

  const item = candidate as NotificationItem & Record<string, unknown>;
  const notification: NotificationItem = {
    id: item.id,
    circleId: item.circleId ?? null,
    type: item.type,
    title: item.title,
    body: item.body ?? null,
    link: item.link ?? null,
    data: item.data ?? null,
    // A freshly-published row is unread by definition when the server omits it.
    readAt: item.readAt ?? null,
    dismissedAt: (item.dismissedAt as string | null | undefined) ?? null,
    createdAt: item.createdAt,
    updatedAt: (item.updatedAt as string | undefined) ?? item.createdAt,
  };

  const unreadCount =
    typeof value.unreadCount === 'number' &&
    Number.isInteger(value.unreadCount) &&
    value.unreadCount >= 0
      ? value.unreadCount
      : undefined;

  return {
    type: 'notification',
    notification,
    toast: value.toast === true,
    pushed: value.pushed === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
    ...(unreadCount !== undefined ? { unreadCount } : {}),
  };
}

export interface NotificationStreamHandlers {
  /** One well-formed frame. Heartbeats never reach here. */
  onEvent: (event: NotificationStreamEvent) => void;
  /**
   * THE REFETCH SIGNAL. Fires on the first connect and on EVERY reconnect; the
   * caller must re-read the unread count (and any loaded list) here.
   */
  onOpen: () => void;
  /** Connection state, for switching polling on and off. Optional. */
  onStateChange?: (state: SseState) => void;
}

/**
 * Connect to this user's notification stream.
 *
 * No user id argument: the recipient is the bearer of the token, resolved
 * server-side. Credentials are read through `api` on every attempt, so a
 * connection that outlives its 15-minute access token reconnects with the
 * current one, and a 401 renews through the same `refreshToken` path every
 * REST call uses.
 */
export function connectNotificationStream(
  handlers: NotificationStreamHandlers,
): SseConnection {
  return connectSse({
    url: NOTIFICATION_STREAM_URL,
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    onOpen: handlers.onOpen,
    onStateChange: handlers.onStateChange,
    onFrame: (frame) => {
      // Compared by NAME, so anything the stream grows later (a `ping` event,
      // say) is ignored rather than mis-parsed as a notification.
      if (frame.event === NOTIFICATION_SYNC_EVENT) {
        handlers.onEvent({ type: 'sync' });
        return;
      }
      if (frame.event !== NOTIFICATION_SSE_EVENT) return;
      const event = parseNotificationEvent(frame.data);
      if (event) handlers.onEvent(event);
    },
  });
}

export type { SseConnection, SseState };
