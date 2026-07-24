import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** GET /api/trash-empty-runs/:id/items query params. */
export const listTrashEmptyRunItemsQuerySchema = z.object({
  status: z.enum(['matched', 'deleted', 'failed', 'skipped']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export class ListTrashEmptyRunItemsQueryDto extends createZodDto(
  listTrashEmptyRunItemsQuerySchema,
) {}
