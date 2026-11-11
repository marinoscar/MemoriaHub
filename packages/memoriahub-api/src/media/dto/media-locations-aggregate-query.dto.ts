import { createZodDto } from 'nestjs-zod';
import { mediaLocationsAggregateQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaLocationsAggregateQuerySchema };

/**
 * The `MediaLocationsAggregateQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MediaLocationsAggregateQueryDto extends createZodDto(mediaLocationsAggregateQuerySchema) {}
