import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bulkResolveDuplicateThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
  action: z.enum(['archive', 'trash']),
});

export class BulkResolveDuplicateThresholdDto extends createZodDto(
  bulkResolveDuplicateThresholdSchema,
) {}
