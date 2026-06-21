import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const bulkArchiveSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export class BulkArchiveDto extends createZodDto(bulkArchiveSchema) {}
