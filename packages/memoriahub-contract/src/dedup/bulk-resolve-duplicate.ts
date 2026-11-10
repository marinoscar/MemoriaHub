import { z } from 'zod';


/**
 * Wire schema `bulkResolveDuplicateSchema`.
 *
 * @stability experimental
 */
export const bulkResolveDuplicateSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['archive', 'trash']),
});

/**
 * The parsed value of {@link bulkResolveDuplicateSchema}.
 *
 * @stability experimental
 */
export type BulkResolveDuplicate = z.infer<typeof bulkResolveDuplicateSchema>;
