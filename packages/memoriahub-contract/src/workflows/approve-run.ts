import { z } from 'zod';

/**
 * POST /api/workflow-runs/:id/approve body.
 *
 * @stability experimental
 */
export const approveRunSchema = z.object({
  /** Item mediaItemIds to exclude from execution (≤500). */
  excludedItemIds: z.array(z.string().uuid()).max(500).optional(),
  /** Required "DELETE <count>" confirmation when the run contains hard_delete. */
  confirmation: z.string().max(200).optional(),
  // .default({}) so a bodyless POST parses as {} — see issue #289 (app.module.ts).
}).default({});

/**
 * The parsed value of {@link approveRunSchema}.
 *
 * @stability experimental
 */
export type ApproveRun = z.infer<typeof approveRunSchema>;
