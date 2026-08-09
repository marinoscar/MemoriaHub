import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Body for `POST /api/memories/:id/save-album`.
 *
 * `name` is optional — omitted means "use the memory's own title", which is
 * already the string the user is looking at. The 256 cap matches
 * `createAlbumSchema` exactly, because this path creates the album through
 * `MediaService.createAlbum` rather than a parallel mutation; a longer default
 * derived from a title is truncated server-side rather than rejected.
 *
 * `.default({})` so a bodyless POST parses as `{}` — same reason
 * `patchUserSettingsSchema` carries one (issue #289).
 */
export const saveMemoryAlbumSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
  })
  .default({});

export class SaveMemoryAlbumDto extends createZodDto(saveMemoryAlbumSchema) {}
