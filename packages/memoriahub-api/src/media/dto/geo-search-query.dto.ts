import { createZodDto } from 'nestjs-zod';
import { geoSearchQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { geoSearchQuerySchema };

/**
 * The `GeoSearchQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class GeoSearchQueryDto extends createZodDto(geoSearchQuerySchema) {}
