import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const addAlbumItemsSchema = z.object({
  mediaItemIds: z
    .array(z.string().uuid('Each mediaItemId must be a valid UUID'))
    .min(1, 'At least one mediaItemId is required'),
});

export class AddAlbumItemsDto extends createZodDto(addAlbumItemsSchema) {}
