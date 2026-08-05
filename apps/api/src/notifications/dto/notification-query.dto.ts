import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query for GET /api/notifications.
 *
 * `status` semantics (see NotificationsService.buildStatusWhere):
 *   - `unread`    — live rows never read
 *   - `read`      — live rows already read
 *   - `all`       — every LIVE row (default)
 *   - `dismissed` — ONLY dismissed rows
 *
 * Dismissed rows are deliberately EXCLUDED from `unread`/`read`/`all`:
 * dismissing is the user saying "stop showing me this", so the only way to
 * see a dismissed row again is to ask for it explicitly.
 */
export const notificationListQuerySchema = z.object({
  status: z.enum(['unread', 'read', 'all', 'dismissed']).default('all'),
  /** Optional circle scope. Global (circle-less) rows are excluded when set. */
  circleId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class NotificationListQueryDto extends createZodDto(notificationListQuerySchema) {}
