import { createZodDto } from 'nestjs-zod';
import { listReviewRunItemsQuerySchema } from '@marinoscar/memoriahub-contract/review-runs';

export { listReviewRunItemsQuerySchema };

/**
 * The `ListReviewRunItemsQueryDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListReviewRunItemsQueryDto extends createZodDto(listReviewRunItemsQuerySchema) {}
