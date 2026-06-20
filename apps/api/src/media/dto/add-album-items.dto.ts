import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const addAlbumItemsSchema = z.object({
  mediaItemIds: z
    .array(z.string().uuid('Each mediaItemId must be a valid UUID'))
    .min(1, 'At least one mediaItemId is required')
    .max(500, 'Cannot add more than 500 items at once'),
});

export class AddAlbumItemsDto extends createZodDto(addAlbumItemsSchema) {}
