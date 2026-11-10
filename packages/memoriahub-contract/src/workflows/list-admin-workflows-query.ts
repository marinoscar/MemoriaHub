import { z } from 'zod';
import { workflowTriggerSchema } from './enums.js';

/**
 * Query for `GET /api/admin/workflows` (admin oversight across all circles).
 * `enabled` arrives as the string 'true'/'false' on the query string and is
 * coerced to a real boolean (z.coerce.boolean would treat 'false' as truthy).
 *
 * @stability experimental
 */
export const listAdminWorkflowsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  circleId: z.string().uuid().optional(),
  trigger: workflowTriggerSchema.optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/**
 * The parsed value of {@link listAdminWorkflowsQuerySchema}.
 *
 * @stability experimental
 */
export type ListAdminWorkflowsQuery = z.infer<typeof listAdminWorkflowsQuerySchema>;
