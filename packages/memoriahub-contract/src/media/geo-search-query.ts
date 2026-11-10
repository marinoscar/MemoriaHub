import { z } from 'zod';


/**
 * Wire schema `geoSearchQuerySchema`.
 *
 * @stability experimental
 */
export const geoSearchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

/**
 * The parsed value of {@link geoSearchQuerySchema}.
 *
 * @stability experimental
 */
export type GeoSearchQuery = z.infer<typeof geoSearchQuerySchema>;
