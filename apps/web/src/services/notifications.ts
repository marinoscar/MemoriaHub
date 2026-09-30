// ---------------------------------------------------------------------------
// Notification Center API client (epic #240, consumes issue #245's endpoints).
//
// Every route is authenticated-any-role — there is no notification permission.
// ---------------------------------------------------------------------------

import { api } from './api';
import type {
  NotificationBulkResult,
  NotificationClientConfig,
  NotificationListParams,
  NotificationListResponse,
  PushSubscriptionPayload,
  PushSubscriptionResponse,
} from '../types/notifications';

/** List the current user's notifications, newest first. */
export async function listNotifications(
  params: NotificationListParams = {},
): Promise<NotificationListResponse> {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.circleId) search.set('circleId', params.circleId);
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));

  const qs = search.toString();
  return api.get<NotificationListResponse>(`/notifications${qs ? `?${qs}` : ''}`);
}

/** Unread count for the bell badge. */
export async function getUnreadCount(): Promise<number> {
  const result = await api.get<{ count: number }>('/notifications/unread-count');
  return result?.count ?? 0;
}

/** Mark one notification read (idempotent, 204). */
export async function markNotificationRead(id: string): Promise<void> {
  await api.post<void>(`/notifications/${id}/read`);
}

/** Dismiss one notification (idempotent, implies read, 204). */
export async function dismissNotification(id: string): Promise<void> {
  await api.post<void>(`/notifications/${id}/dismiss`);
}

/** Hard-delete one notification (204). */
export async function deleteNotification(id: string): Promise<void> {
  await api.delete<void>(`/notifications/${id}`);
}

/**
 * Mark every unread notification read, optionally scoped to one circle.
 *
 * NOTE — deliberately always sends a real JSON object body, even when
 * unscoped. `api.post` only sets `Content-Type: application/json` when a body
 * is present, but its 401-refresh retry path sets that header unconditionally;
 * a `Content-Type: application/json` request with a ZERO-LENGTH body is
 * rejected by Fastify itself (`FST_ERR_CTP_EMPTY_JSON_BODY`) before Nest's
 * validation ever runs. Passing an object here means `JSON.stringify` always
 * produces at least `"{}"`, which the endpoint's `NotificationScopeDto`
 * (`z.object({...}).default({})`) explicitly accepts as "all circles".
 */
export async function markAllNotificationsRead(
  circleId?: string,
): Promise<NotificationBulkResult> {
  return api.post<NotificationBulkResult>('/notifications/read-all', { circleId });
}

/** Dismiss every live notification, optionally scoped to one circle. See above. */
export async function dismissAllNotifications(
  circleId?: string,
): Promise<NotificationBulkResult> {
  return api.post<NotificationBulkResult>('/notifications/dismiss-all', { circleId });
}

/**
 * This deployment's client-facing notification capabilities (epic #481):
 * whether Web Push is on (and its VAPID public key), whether browser toasts are
 * allowed, and which types may travel by push.
 */
export async function getNotificationConfig(): Promise<NotificationClientConfig> {
  return api.get<NotificationClientConfig>('/notifications/config');
}

/**
 * Register (or refresh) this browser's Web Push subscription for the caller
 * (issue #486). Upserted by `endpoint` server-side, so calling it on every boot
 * is the self-heal, not a duplicate. 409 when push is disabled.
 */
export async function subscribePushNotifications(
  subscription: PushSubscriptionPayload,
): Promise<PushSubscriptionResponse> {
  return api.post<PushSubscriptionResponse>('/notifications/push/subscriptions', subscription);
}

/**
 * Remove this browser's Web Push subscription for the caller (issue #486). A
 * `DELETE` with a JSON body: the endpoint URL is the only handle on the row.
 * 404 when the caller has no such subscription.
 */
export async function unsubscribePushNotifications(endpoint: string): Promise<void> {
  await api.delete<void>('/notifications/push/subscriptions', {
    body: JSON.stringify({ endpoint }),
  });
}
