import { z } from 'zod';


/**
 * Wire schema `albumQuerySchema`.
 *
 * @stability experimental
 */
export const albumQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * The parsed value of {@link albumQuerySchema}.
 *
 * @stability experimental
 */
export type AlbumQuery = z.infer<typeof albumQuerySchema>;
