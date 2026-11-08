/**
 * The inbox page's list query (RETRO-D3, #576). Every other notification call
 * (mark read, dismiss, the bulk actions, the stream, push) goes through the
 * platform slice's `useNotifications()` and its configured client. The list is
 * read here because the platform exports no paged-list hook: it is the
 * platform route `GET /api/notifications?status=&page=&pageSize=`, whose items
 * are mapped to the page's `NotificationItem`.
 */
import type { AppNotification } from '@marinoscar/platform-web/notifications/headless';

import { api } from './api';
import {
  EVENT_KEY_TO_NOTIFICATION_TYPE,
  type NotificationItem,
  type NotificationListParams,
  type NotificationListResponse,
} from '../types/notifications';

interface PlatformListResponse {
  items: AppNotification[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** The platform inbox row as the page renders it. */
export function toNotificationItem(n: AppNotification): NotificationItem {
  return {
    id: n.id,
    eventKey: n.eventKey,
    type: EVENT_KEY_TO_NOTIFICATION_TYPE[n.eventKey] ?? n.eventKey,
    circleId: n.scopeId ?? null,
    title: n.title,
    body: n.body ? n.body : null,
    link: n.link,
    data: typeof n.count === 'number' ? { count: n.count } : null,
    readAt: n.readAt,
    dismissedAt: n.dismissedAt ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt ?? n.createdAt,
  };
}

export async function listNotifications(
  params: NotificationListParams = {},
): Promise<NotificationListResponse> {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));

  const qs = search.toString();
  const result = await api.get<PlatformListResponse>(`/notifications${qs ? `?${qs}` : ''}`);
  return {
    items: (result?.items ?? []).map(toNotificationItem),
    meta: {
      page: result?.page ?? params.page ?? 1,
      pageSize: result?.pageSize ?? params.pageSize ?? 25,
      totalItems: result?.total ?? 0,
      totalPages: result?.totalPages ?? 0,
    },
  };
}
