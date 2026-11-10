import { z } from 'zod';


/**
 * Wire schema `updateAlbumSchema`.
 *
 * @stability experimental
 */
export const updateAlbumSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).nullable().optional(),
  // Album cover pointer: a valid member's UUID sets the cover, null clears it,
  // omitted leaves the existing cover untouched.
  coverMediaItemId: z.string().uuid().nullable().optional(),
  // .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
}).default({});

/**
 * The parsed value of {@link updateAlbumSchema}.
 *
 * @stability experimental
 */
export type UpdateAlbum = z.infer<typeof updateAlbumSchema>;
