import { z } from 'zod';


/**
 * Wire schema `burstQuerySchema`.
 *
 * @stability experimental
 */
export const burstQuerySchema = z.object({
  circleId: z.string().uuid(),
  status: z.enum(['pending', 'resolved', 'dismissed']).optional().default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['capturedAt', 'confidence', 'mediaCount']).default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

/**
 * The parsed value of {@link burstQuerySchema}.
 *
 * @stability experimental
 */
export type BurstQuery = z.infer<typeof burstQuerySchema>;
