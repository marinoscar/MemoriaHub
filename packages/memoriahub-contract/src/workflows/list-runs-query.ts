import { z } from 'zod';

/**
 * GET /api/workflows/:id/runs query params.
 *
 * @stability experimental
 */
export const listRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * The parsed value of {@link listRunsQuerySchema}.
 *
 * @stability experimental
 */
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;
