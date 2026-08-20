import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** GET /api/enhancement-batches query params (epic #420, issue #421). */
export const listEnhancementBatchesQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListEnhancementBatchesQuery = z.infer<
  typeof listEnhancementBatchesQuerySchema
>;

export class ListEnhancementBatchesQueryDto extends createZodDto(
  listEnhancementBatchesQuerySchema,
) {}
