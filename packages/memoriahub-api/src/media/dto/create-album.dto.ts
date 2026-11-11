import { createZodDto } from 'nestjs-zod';
import { createAlbumSchema } from '@marinoscar/memoriahub-contract/media';

export { createAlbumSchema };

/**
 * The `CreateAlbumDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CreateAlbumDto extends createZodDto(createAlbumSchema) {}
