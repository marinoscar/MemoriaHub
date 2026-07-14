import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bulkResolveBurstThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
  action: z.enum(['archive', 'trash']),
});

export class BulkResolveBurstThresholdDto extends createZodDto(
  bulkResolveBurstThresholdSchema,
) {}
