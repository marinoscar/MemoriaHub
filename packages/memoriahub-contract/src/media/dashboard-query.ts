import { z } from 'zod';


/**
 * Wire schema `dashboardQuerySchema`.
 *
 * @stability experimental
 */
export const dashboardQuerySchema = z.object({
  circleId: z.string().uuid(),
});

/**
 * The parsed value of {@link dashboardQuerySchema}.
 *
 * @stability experimental
 */
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
