import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WorkflowRunStatus } from '@prisma/client';

/**
 * Query for `GET /api/admin/workflow-runs` (admin oversight across all circles).
 */
const listAdminWorkflowRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(WorkflowRunStatus).optional(),
  circleId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
});

export class ListAdminWorkflowRunsQueryDto extends createZodDto(listAdminWorkflowRunsQuerySchema) {}
