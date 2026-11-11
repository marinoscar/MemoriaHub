import { createZodDto } from 'nestjs-zod';
import { mediaLocationsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaLocationsQuerySchema };

/**
 * The `MediaLocationsQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MediaLocationsQueryDto extends createZodDto(mediaLocationsQuerySchema) {}
