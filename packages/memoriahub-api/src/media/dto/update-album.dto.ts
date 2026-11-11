import { createZodDto } from 'nestjs-zod';
import { updateAlbumSchema } from '@marinoscar/memoriahub-contract/media';

export { updateAlbumSchema };

/**
 * The `UpdateAlbumDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class UpdateAlbumDto extends createZodDto(updateAlbumSchema) {}
