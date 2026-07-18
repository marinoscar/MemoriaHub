import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** GET /api/workflows query params. */
export const listWorkflowsQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class ListWorkflowsQueryDto extends createZodDto(listWorkflowsQuerySchema) {}
