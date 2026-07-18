import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { workflowDefinitionSchema } from '../definition/workflow-definition.schema';

/**
 * PATCH /api/workflows/:id body. All fields optional; `circleId` and
 * `subjectType` are immutable (subjectType follows `definition.subject` when a
 * new definition is supplied). Cron validity is enforced in the service.
 */
export const updateWorkflowSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
    trigger: z.enum(['manual', 'on_media_enriched', 'scheduled']).optional(),
    cronExpression: z.string().max(200).nullable().optional(),
    definition: workflowDefinitionSchema.optional(),
  })
  .strict();

export class UpdateWorkflowDto extends createZodDto(updateWorkflowSchema) {}
