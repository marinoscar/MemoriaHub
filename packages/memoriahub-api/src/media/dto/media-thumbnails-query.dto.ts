import { createZodDto } from 'nestjs-zod';
import { mediaThumbnailsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { mediaThumbnailsQuerySchema };

export class MediaThumbnailsQueryDto extends createZodDto(mediaThumbnailsQuerySchema) {}
