import { z } from 'zod';


/**
 * GET /api/review-runs/:id/items query params.
 *
 * @stability experimental
 */
export const listReviewRunItemsQuerySchema = z.object({
  status: z.enum(['matched', 'processing', 'applied', 'failed', 'skipped']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The parsed value of {@link listReviewRunItemsQuerySchema}.
 *
 * @stability experimental
 */
export type ListReviewRunItemsQuery = z.infer<typeof listReviewRunItemsQuerySchema>;
