import { createZodDto } from 'nestjs-zod';
import { mediaLocationsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaLocationsQuerySchema };

export class MediaLocationsQueryDto extends createZodDto(mediaLocationsQuerySchema) {}
