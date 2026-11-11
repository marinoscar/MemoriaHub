import { createZodDto } from 'nestjs-zod';
import { addAlbumItemsByFilterSchema } from '@marinoscar/memoriahub-contract/media';

export { addAlbumItemsByFilterSchema };

export class AddAlbumItemsByFilterDto extends createZodDto(addAlbumItemsByFilterSchema) {}
