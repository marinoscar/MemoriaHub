import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Optional body for the two bulk endpoints (read-all / dismiss-all).
 *
 * `circleId` deliberately has NO default: an empty body means "every
 * notification for this user, across all circles" — mirroring the empty-body
 * convention already used by ResetStuckDto in the enrichment admin controller.
 */
export const notificationScopeSchema = z.object({
  circleId: z.string().uuid().optional(),
});

export class NotificationScopeDto extends createZodDto(notificationScopeSchema) {}
