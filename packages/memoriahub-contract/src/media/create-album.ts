import { z } from 'zod';


/**
 * Wire schema `createAlbumSchema`.
 *
 * @stability experimental
 */
export const createAlbumSchema = z.object({
  circleId: z.string().uuid(),
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
});

/**
 * The parsed value of {@link createAlbumSchema}.
 *
 * @stability experimental
 */
export type CreateAlbum = z.infer<typeof createAlbumSchema>;
