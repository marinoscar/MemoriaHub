// ---------------------------------------------------------------------------
// Notification Center API client (epic #240, consumes issue #245's endpoints).
//
// Every route is authenticated-any-role — there is no notification permission.
// ---------------------------------------------------------------------------

import { api } from './api';
import type {
  NotificationBulkResult,
  NotificationListParams,
  NotificationListResponse,
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
