import { z } from 'zod';


/**
 * Query for GET /api/media/review-counts.
 *
 * Deliberately its own schema rather than a reuse of dashboardQuerySchema:
 * the two endpoints happen to take the same single field today, but the whole
 * point of the review-counts endpoint is that it is NOT the dashboard, so a
 * future dashboard-only parameter must not silently become part of this
 * contract.
 *
 * @stability experimental
 */
export const reviewCountsQuerySchema = z.object({
  circleId: z.string().uuid(),
});

/**
 * The parsed value of {@link reviewCountsQuerySchema}.
 *
 * @stability experimental
 */
export type ReviewCountsQuery = z.infer<typeof reviewCountsQuerySchema>;
