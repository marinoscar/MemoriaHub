import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { workflowDefinitionSchema } from '../definition/workflow-definition.schema';

/**
 * POST /api/workflows body. `subjectType` is NOT accepted here — it is derived
 * from `definition.subject` so the two can never disagree. Cron validity for a
 * `scheduled` trigger is enforced in the service (kept out of the DTO so
 * createZodDto stays a plain ZodObject).
 */
export const createWorkflowSchema = z.object({
  circleId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional().default(true),
  trigger: z.enum(['manual', 'on_media_enriched', 'scheduled']).optional().default('manual'),
  cronExpression: z.string().max(200).nullable().optional(),
  definition: workflowDefinitionSchema,
});

export class CreateWorkflowDto extends createZodDto(createWorkflowSchema) {}
