import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateAlbumSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).nullable().optional(),
});

export class UpdateAlbumDto extends createZodDto(updateAlbumSchema) {}
