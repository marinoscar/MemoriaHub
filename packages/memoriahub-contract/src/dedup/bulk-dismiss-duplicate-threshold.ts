import { z } from 'zod';


/**
 * Wire schema `bulkDismissDuplicateThresholdSchema`.
 *
 * @stability experimental
 */
export const bulkDismissDuplicateThresholdSchema = z.object({
  circleId: z.string().uuid(),
  threshold: z.coerce.number().int().min(0).max(100),
});

/**
 * The parsed value of {@link bulkDismissDuplicateThresholdSchema}.
 *
 * @stability experimental
 */
export type BulkDismissDuplicateThreshold = z.infer<typeof bulkDismissDuplicateThresholdSchema>;
