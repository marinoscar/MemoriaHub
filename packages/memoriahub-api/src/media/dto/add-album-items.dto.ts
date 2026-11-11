import { createZodDto } from 'nestjs-zod';
import { addAlbumItemsSchema } from '@marinoscar/memoriahub-contract/media';

export { addAlbumItemsSchema };

export class AddAlbumItemsDto extends createZodDto(addAlbumItemsSchema) {}
