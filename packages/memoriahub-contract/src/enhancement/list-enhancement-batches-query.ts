import { z } from 'zod';


/**
 * GET /api/enhancement-batches query params (epic #420, issue #421).
 *
 * @stability experimental
 */
export const listEnhancementBatchesQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Wire type `ListEnhancementBatchesQuery`.
 *
 * @stability experimental
 */
export type ListEnhancementBatchesQuery = z.infer<
  typeof listEnhancementBatchesQuerySchema
>;
