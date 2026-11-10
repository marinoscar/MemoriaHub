import { z } from 'zod';


/**
 * Wire schema `bulkResolveDuplicateThresholdSchema`.
 *
 * @stability experimental
 */
export const bulkResolveDuplicateThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
  action: z.enum(['archive', 'trash']),
});

/**
 * The parsed value of {@link bulkResolveDuplicateThresholdSchema}.
 *
 * @stability experimental
 */
export type BulkResolveDuplicateThreshold = z.infer<typeof bulkResolveDuplicateThresholdSchema>;
