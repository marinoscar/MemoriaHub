import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateAlbumSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).nullable().optional(),
  // Album cover pointer: a valid member's UUID sets the cover, null clears it,
  // omitted leaves the existing cover untouched.
  coverMediaItemId: z.string().uuid().nullable().optional(),
});

export class UpdateAlbumDto extends createZodDto(updateAlbumSchema) {}
