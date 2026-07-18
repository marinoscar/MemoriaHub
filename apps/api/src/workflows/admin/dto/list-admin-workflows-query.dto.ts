import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WorkflowTrigger } from '@prisma/client';

/**
 * Query for `GET /api/admin/workflows` (admin oversight across all circles).
 * `enabled` arrives as the string 'true'/'false' on the query string and is
 * coerced to a real boolean (z.coerce.boolean would treat 'false' as truthy).
 */
const listAdminWorkflowsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  circleId: z.string().uuid().optional(),
  trigger: z.nativeEnum(WorkflowTrigger).optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export class ListAdminWorkflowsQueryDto extends createZodDto(listAdminWorkflowsQuerySchema) {}
