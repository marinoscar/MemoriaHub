import { createZodDto } from 'nestjs-zod';
import { albumQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { albumQuerySchema };

/**
 * The `AlbumQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class AlbumQueryDto extends createZodDto(albumQuerySchema) {}
