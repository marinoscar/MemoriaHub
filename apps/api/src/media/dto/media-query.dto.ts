import { createZodDto } from 'nestjs-zod';
import { mediaFilterFields, mediaQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaFilterFields, mediaQuerySchema };

export class MediaQueryDto extends createZodDto(mediaQuerySchema) {}
