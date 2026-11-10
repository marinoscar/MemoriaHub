import { z } from 'zod';


/**
 * Wire schema `listTrashQuerySchema`.
 *
 * @stability experimental
 */
export const listTrashQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The parsed value of {@link listTrashQuerySchema}.
 *
 * @stability experimental
 */
export type ListTrashQuery = z.infer<typeof listTrashQuerySchema>;
