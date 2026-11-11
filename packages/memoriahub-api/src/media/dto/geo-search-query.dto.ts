import { createZodDto } from 'nestjs-zod';
import { geoSearchQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { geoSearchQuerySchema };

export class GeoSearchQueryDto extends createZodDto(geoSearchQuerySchema) {}
