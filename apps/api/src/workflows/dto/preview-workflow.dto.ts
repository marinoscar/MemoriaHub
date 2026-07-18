import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { workflowDefinitionSchema } from '../definition/workflow-definition.schema';

/** POST /api/workflows/preview body — stateless builder feedback. */
export const previewWorkflowSchema = z.object({
  circleId: z.string().uuid(),
  definition: workflowDefinitionSchema,
});

export class PreviewWorkflowDto extends createZodDto(previewWorkflowSchema) {}
