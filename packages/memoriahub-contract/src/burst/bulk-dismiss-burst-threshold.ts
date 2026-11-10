import { z } from 'zod';


/**
 * Wire schema `bulkDismissBurstThresholdSchema`.
 *
 * @stability experimental
 */
export const bulkDismissBurstThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
});

/**
 * The parsed value of {@link bulkDismissBurstThresholdSchema}.
 *
 * @stability experimental
 */
export type BulkDismissBurstThreshold = z.infer<typeof bulkDismissBurstThresholdSchema>;
