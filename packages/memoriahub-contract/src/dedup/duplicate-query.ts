import { z } from 'zod';


/**
 * Wire schema `duplicateQuerySchema`.
 *
 * @stability experimental
 */
export const duplicateQuerySchema = z.object({
  circleId: z.string().uuid(),
  status: z.enum(['pending', 'resolved', 'dismissed']).optional().default('pending'),
  kind: z.enum(['exact_variant', 'edited', 'similar']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['capturedAt', 'confidence', 'mediaCount']).default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

/**
 * The parsed value of {@link duplicateQuerySchema}.
 *
 * @stability experimental
 */
export type DuplicateQuery = z.infer<typeof duplicateQuerySchema>;
