import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const schema = z.object({
  circleId: z.string().uuid(),
  status: z.enum(['pending', 'resolved', 'dismissed']).optional().default('pending'),
  kind: z.enum(['exact_variant', 'edited', 'similar']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class DuplicateQueryDto extends createZodDto(schema) {}
