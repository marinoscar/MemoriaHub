import { createZodDto } from 'nestjs-zod';
import { mediaThumbnailsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaThumbnailsQuerySchema };

/**
 * The `MediaThumbnailsQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class MediaThumbnailsQueryDto extends createZodDto(mediaThumbnailsQuerySchema) {}
