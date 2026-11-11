import { createZodDto } from 'nestjs-zod';
import { mediaLocationsExtentQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaLocationsExtentQuerySchema };

/**
 * The `MediaLocationsExtentQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MediaLocationsExtentQueryDto extends createZodDto(mediaLocationsExtentQuerySchema) {}
