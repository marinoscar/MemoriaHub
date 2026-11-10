import { z } from 'zod';

/**
 * GET /api/workflow-runs/:id/items query params.
 *
 * @stability experimental
 */
export const listRunItemsQuerySchema = z.object({
  status: z
    .enum(['matched', 'excluded', 'applied', 'partially_applied', 'failed', 'skipped'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The parsed value of {@link listRunItemsQuerySchema}.
 *
 * @stability experimental
 */
export type ListRunItemsQuery = z.infer<typeof listRunItemsQuerySchema>;
