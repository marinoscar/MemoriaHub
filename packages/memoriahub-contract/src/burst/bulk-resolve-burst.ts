import { z } from 'zod';


/**
 * Wire schema `bulkResolveBurstSchema`.
 *
 * @stability experimental
 */
export const bulkResolveBurstSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['archive', 'trash']),
});

/**
 * The parsed value of {@link bulkResolveBurstSchema}.
 *
 * @stability experimental
 */
export type BulkResolveBurst = z.infer<typeof bulkResolveBurstSchema>;
