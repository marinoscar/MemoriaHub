import { createZodDto } from 'nestjs-zod';
import { addAlbumItemsSchema } from '@marinoscar/memoriahub-contract/media';

export { addAlbumItemsSchema };

/**
 * The `AddAlbumItemsDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class AddAlbumItemsDto extends createZodDto(addAlbumItemsSchema) {}
