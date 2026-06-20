import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { mediaFilterFields } from './media-query.dto';

export const addAlbumItemsByFilterSchema = z.object({
  ...mediaFilterFields,
  // circleId is required here (not optional like in mediaFilterFields)
  circleId: z.string().uuid(),
});

export class AddAlbumItemsByFilterDto extends createZodDto(addAlbumItemsByFilterSchema) {}
