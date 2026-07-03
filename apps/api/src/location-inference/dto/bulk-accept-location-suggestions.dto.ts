import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z.object({
  circleId: z.string().uuid(),
  minConfidence: z.number().min(0).max(1),
});

export class BulkAcceptLocationSuggestionsDto extends createZodDto(schema) {}
