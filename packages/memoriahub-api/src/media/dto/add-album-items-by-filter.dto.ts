import { createZodDto } from 'nestjs-zod';
import { addAlbumItemsByFilterSchema } from '@marinoscar/memoriahub-contract/media';

export { addAlbumItemsByFilterSchema };

/**
 * The `AddAlbumItemsByFilterDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class AddAlbumItemsByFilterDto extends createZodDto(addAlbumItemsByFilterSchema) {}
