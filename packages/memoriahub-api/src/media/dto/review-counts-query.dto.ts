import { createZodDto } from 'nestjs-zod';
import { reviewCountsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { reviewCountsQuerySchema };

export class ReviewCountsQueryDto extends createZodDto(reviewCountsQuerySchema) {}
