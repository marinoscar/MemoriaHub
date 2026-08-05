import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A single notification row as returned by the API.
 *
 * Timestamps are ISO 8601 strings. `data` is the free-form JSONB payload the
 * producer wrote — for the four `review_queue_*` STATE types it carries
 * `{ count, countAtRead? }`; see NotificationsService for the countAtRead
 * snapshot contract.
 */
export const notificationItemSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid().nullable(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  data: z.unknown().nullable(),
  readAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class NotificationItemDto extends createZodDto(notificationItemSchema) {}

/**
 * Paginated envelope for GET /api/notifications.
 *
 * NOTE: this is the handler's RETURN value, not the wire format. The global
 * TransformInterceptor wraps it as `{ data: <this>, meta: { timestamp } }`,
 * so the pagination meta lands at `data.meta` — the same shape produced by
 * ShareService.listShares.
 */
export const notificationListSchema = z.object({
  items: z.array(notificationItemSchema),
  meta: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    totalItems: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export class NotificationListDto extends createZodDto(notificationListSchema) {}

/** Response for GET /api/notifications/unread-count. */
export const unreadCountSchema = z.object({ count: z.number().int() });

export class UnreadCountDto extends createZodDto(unreadCountSchema) {}

/** Response for the two bulk endpoints. */
export const bulkResultSchema = z.object({ updated: z.number().int() });

export class BulkResultDto extends createZodDto(bulkResultSchema) {}
