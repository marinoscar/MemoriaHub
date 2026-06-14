import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createAlbumSchema = z.object({
  circleId: z.string().uuid(),
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
});

export class CreateAlbumDto extends createZodDto(createAlbumSchema) {}
