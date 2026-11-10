import { z } from 'zod';


/**
 * Wire schema `bulkResolveBurstThresholdSchema`.
 *
 * @stability experimental
 */
export const bulkResolveBurstThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
  action: z.enum(['archive', 'trash']),
});

/**
 * The parsed value of {@link bulkResolveBurstThresholdSchema}.
 *
 * @stability experimental
 */
export type BulkResolveBurstThreshold = z.infer<typeof bulkResolveBurstThresholdSchema>;
