import { z } from 'zod';
import { mediaFilterFields } from './media-query.js';


/**
 * Wire schema `addAlbumItemsByFilterSchema`.
 *
 * @stability experimental
 */
export const addAlbumItemsByFilterSchema = z.object({
  ...mediaFilterFields,
  // circleId is required here (not optional like in mediaFilterFields)
  circleId: z.string().uuid(),
});

/**
 * The parsed value of {@link addAlbumItemsByFilterSchema}.
 *
 * @stability experimental
 */
export type AddAlbumItemsByFilter = z.infer<typeof addAlbumItemsByFilterSchema>;
