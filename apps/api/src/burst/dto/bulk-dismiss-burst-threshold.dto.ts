import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bulkDismissBurstThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
});

export class BulkDismissBurstThresholdDto extends createZodDto(
  bulkDismissBurstThresholdSchema,
) {}
