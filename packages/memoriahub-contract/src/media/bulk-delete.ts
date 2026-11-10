import { z } from 'zod';


/**
 * Wire schema `bulkDeleteSchema`.
 *
 * @stability experimental
 */
export const bulkDeleteSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * The parsed value of {@link bulkDeleteSchema}.
 *
 * @stability experimental
 */
export type BulkDelete = z.infer<typeof bulkDeleteSchema>;
