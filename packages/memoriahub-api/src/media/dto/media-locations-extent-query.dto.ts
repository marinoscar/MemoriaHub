import { createZodDto } from 'nestjs-zod';
import { mediaLocationsExtentQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaLocationsExtentQuerySchema };

export class MediaLocationsExtentQueryDto extends createZodDto(mediaLocationsExtentQuerySchema) {}
