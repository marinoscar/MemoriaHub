import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** POST /api/workflow-runs/:id/approve body. */
export const approveRunSchema = z.object({
  /** Item mediaItemIds to exclude from execution (≤500). */
  excludedItemIds: z.array(z.string().uuid()).max(500).optional(),
  /** Required "DELETE <count>" confirmation when the run contains hard_delete. */
  confirmation: z.string().max(200).optional(),
});

export class ApproveRunDto extends createZodDto(approveRunSchema) {}
