import { z } from 'zod';
import { workflowDefinitionSchema } from './workflow-definition.js';

/**
 * POST /api/workflows/preview body — stateless builder feedback.
 *
 * @stability experimental
 */
export const previewWorkflowSchema = z.object({
  circleId: z.string().uuid(),
  definition: workflowDefinitionSchema,
});

/**
 * The parsed value of {@link previewWorkflowSchema}.
 *
 * @stability experimental
 */
export type PreviewWorkflow = z.infer<typeof previewWorkflowSchema>;
