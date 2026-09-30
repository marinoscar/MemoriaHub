import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { BROADCAST_STATUSES } from '../broadcast-constants';

/** Query for GET /api/admin/broadcasts. */
export const broadcastListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(BROADCAST_STATUSES).optional(),
});

export class BroadcastListQueryDto extends createZodDto(broadcastListQuerySchema) {}

export type BroadcastListQuery = z.output<typeof broadcastListQuerySchema>;
