import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const searchQuerySchema = z.object({
  circleId: z.string().uuid(),
  filters: z.record(z.string(), z.unknown()).default({}),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['capturedAt', 'importedAt', 'createdAt']).default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class SearchQueryDto extends createZodDto(searchQuerySchema) {}
