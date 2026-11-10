import { z } from 'zod';


/**
 * Wire schema `bulkArchiveSchema`.
 *
 * @stability experimental
 */
export const bulkArchiveSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * The parsed value of {@link bulkArchiveSchema}.
 *
 * @stability experimental
 */
export type BulkArchive = z.infer<typeof bulkArchiveSchema>;
