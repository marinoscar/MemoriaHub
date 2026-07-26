import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** GET /api/review-runs/:id/items query params. */
export const listReviewRunItemsQuerySchema = z.object({
  status: z.enum(['matched', 'processing', 'applied', 'failed', 'skipped']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export class ListReviewRunItemsQueryDto extends createZodDto(listReviewRunItemsQuerySchema) {}
