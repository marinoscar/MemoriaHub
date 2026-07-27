import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const locationSuggestionQuerySchema = z.object({
  circleId: z.string().uuid(),
  status: z.enum(['pending', 'accepted', 'rejected', 'auto_applied', 'reverted']).optional().default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  mediaItemId: z.string().uuid().optional(),
  sortBy: z.enum(['createdAt', 'confidence']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class LocationSuggestionQueryDto extends createZodDto(locationSuggestionQuerySchema) {}
