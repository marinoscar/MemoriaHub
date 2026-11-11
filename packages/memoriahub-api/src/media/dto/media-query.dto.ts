import { createZodDto } from 'nestjs-zod';
import { mediaFilterFields, mediaQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaFilterFields, mediaQuerySchema };

/**
 * The `MediaQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MediaQueryDto extends createZodDto(mediaQuerySchema) {}
