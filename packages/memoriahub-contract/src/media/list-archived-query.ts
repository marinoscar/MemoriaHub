import { z } from 'zod';


/**
 * Wire schema `listArchivedQuerySchema`.
 *
 * @stability experimental
 */
export const listArchivedQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The parsed value of {@link listArchivedQuerySchema}.
 *
 * @stability experimental
 */
export type ListArchivedQuery = z.infer<typeof listArchivedQuerySchema>;
