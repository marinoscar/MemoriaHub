import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bulkResolveBurstSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['archive', 'trash']),
});

export class BulkResolveBurstDto extends createZodDto(bulkResolveBurstSchema) {}
