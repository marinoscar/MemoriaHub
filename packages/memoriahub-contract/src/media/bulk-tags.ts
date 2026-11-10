import { z } from 'zod';


/**
 * Wire schema `bulkTagsSchema`.
 *
 * @stability experimental
 */
export const bulkTagsSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
  add: z.array(z.string().max(128)).optional(),
  remove: z.array(z.string().max(128)).optional(),
}).refine(
  (d) => (d.add && d.add.length > 0) || (d.remove && d.remove.length > 0),
  { message: 'At least one of add or remove must be non-empty' },
);

/**
 * The parsed value of {@link bulkTagsSchema}.
 *
 * @stability experimental
 */
export type BulkTags = z.infer<typeof bulkTagsSchema>;
