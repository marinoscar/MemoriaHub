import { z } from 'zod';

/**
 * GET /api/workflows query params.
 *
 * @stability experimental
 */
export const listWorkflowsQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * The parsed value of {@link listWorkflowsQuerySchema}.
 *
 * @stability experimental
 */
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuerySchema>;
