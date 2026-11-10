import { z } from 'zod';

/**
 * Wire schema `adminDuplicateBackfillSchema`.
 *
 * @stability experimental
 */
export const adminDuplicateBackfillSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional().default(false),
}).prefault({});

/**
 * Wire schema `adminDuplicateConfidenceBackfillSchema`.
 *
 * @stability experimental
 */
export const adminDuplicateConfidenceBackfillSchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
}).default({});

/**
 * The parsed value of {@link adminDuplicateBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminDuplicateBackfill = z.infer<typeof adminDuplicateBackfillSchema>;

/**
 * The parsed value of {@link adminDuplicateConfidenceBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminDuplicateConfidenceBackfill = z.infer<typeof adminDuplicateConfidenceBackfillSchema>;
