import { createZodDto } from 'nestjs-zod';
import { mediaLocationsAggregateQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaLocationsAggregateQuerySchema };

export class MediaLocationsAggregateQueryDto extends createZodDto(mediaLocationsAggregateQuerySchema) {}
