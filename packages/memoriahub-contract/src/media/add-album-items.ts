import { z } from 'zod';


/**
 * Wire schema `addAlbumItemsSchema`.
 *
 * @stability experimental
 */
export const addAlbumItemsSchema = z.object({
  mediaItemIds: z
    .array(z.string().uuid('Each mediaItemId must be a valid UUID'))
    .min(1, 'At least one mediaItemId is required')
    .max(500, 'Cannot add more than 500 items at once'),
});

/**
 * The parsed value of {@link addAlbumItemsSchema}.
 *
 * @stability experimental
 */
export type AddAlbumItems = z.infer<typeof addAlbumItemsSchema>;
