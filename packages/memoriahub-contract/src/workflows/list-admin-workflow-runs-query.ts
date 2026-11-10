import { z } from 'zod';
import { workflowRunStatusSchema } from './enums.js';

/**
 * Query for `GET /api/admin/workflow-runs` (admin oversight across all circles).
 *
 * @stability experimental
 */
export const listAdminWorkflowRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: workflowRunStatusSchema.optional(),
  circleId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
});

/**
 * The parsed value of {@link listAdminWorkflowRunsQuerySchema}.
 *
 * @stability experimental
 */
export type ListAdminWorkflowRunsQuery = z.infer<typeof listAdminWorkflowRunsQuerySchema>;
