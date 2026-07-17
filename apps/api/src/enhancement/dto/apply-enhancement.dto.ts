import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Body for POST /api/media/:id/enhance/:enhancementId/apply (spec §8.4).
 *   - keep_both: create a NEW MediaItem from the staged enhanced bytes.
 *   - replace: destructively overwrite the original item's bytes.
 */
export const applyEnhancementSchema = z.object({
  decision: z.enum(['keep_both', 'replace']),
});

export class ApplyEnhancementDto extends createZodDto(applyEnhancementSchema) {}
