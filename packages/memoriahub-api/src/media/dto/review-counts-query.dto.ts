import { createZodDto } from 'nestjs-zod';
import { reviewCountsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { reviewCountsQuerySchema };

/**
 * The `ReviewCountsQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ReviewCountsQueryDto extends createZodDto(reviewCountsQuerySchema) {}
