import { createZodDto } from 'nestjs-zod';
import { listReviewRunItemsQuerySchema } from '@marinoscar/memoriahub-contract/review-runs';

export { listReviewRunItemsQuerySchema };

export class ListReviewRunItemsQueryDto extends createZodDto(listReviewRunItemsQuerySchema) {}
