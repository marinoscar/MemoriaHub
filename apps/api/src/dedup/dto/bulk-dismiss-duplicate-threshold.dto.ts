import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bulkDismissDuplicateThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
});

export class BulkDismissDuplicateThresholdDto extends createZodDto(
  bulkDismissDuplicateThresholdSchema,
) {}
