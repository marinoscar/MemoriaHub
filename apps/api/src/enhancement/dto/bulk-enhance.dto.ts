import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { enhanceParamsSchema } from './enhance-params.dto';

/**
 * Request body for POST /api/media/bulk/enhance (epic #420, issue #421).
 *
 * One `params` object applies to EVERY item in the batch — a bulk enhance is a
 * single intent applied across a selection, not per-item tuning — and is
 * snapshotted on the batch row as the audit of what was asked for.
 *
 * NOTE on the two caps: `.max(200)` here is a SCHEMA BACKSTOP only, bounding the
 * request body so a pathological payload is rejected before it reaches the
 * service. The AUTHORITATIVE limit is the `pictureEnhancement.maxBatchSize`
 * system setting, enforced in MediaEnhancementService.startBatch — an admin
 * lowering that setting to 10 must actually cap batches at 10, which a static
 * schema max cannot express.
 */
export const bulkEnhanceSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(200),
  params: enhanceParamsSchema.optional().default({}),
});

export type BulkEnhance = z.infer<typeof bulkEnhanceSchema>;

export class BulkEnhanceDto extends createZodDto(bulkEnhanceSchema) {}
