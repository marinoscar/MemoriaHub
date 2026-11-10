import { z } from 'zod';
import { workflowDefinitionSchema } from './workflow-definition.js';

/**
 * PATCH /api/workflows/:id body. All fields optional; `circleId` and
 * `subjectType` are immutable (subjectType follows `definition.subject` when a
 * new definition is supplied). Cron validity is enforced in the service.
 *
 * `.default({})` comes LAST, after `.strict()`, so a bodyless request parses as
 * {} while unknown keys still throw — see issue #289 (app.module.ts).
 *
 * @stability experimental
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
  .strict()
  .default({});

/**
 * The parsed value of {@link updateWorkflowSchema}.
 *
 * @stability experimental
 */
export type UpdateWorkflow = z.infer<typeof updateWorkflowSchema>;
