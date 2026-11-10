import { z } from 'zod';

/**
 * Concrete `MediaEnhancementStatus` values, in the order of the database enum.
 *
 * @stability stable
 */
export const ENHANCEMENT_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
  'applied',
  'discarded',
  'expired',
  'cancelled',
] as const;

/**
 * One concrete enhancement status.
 *
 * @stability stable
 */
export type EnhancementStatus = (typeof ENHANCEMENT_STATUSES)[number];

/**
 * Three convenience aliases the hub UI thinks in terms of, so a client can ask
 * for "everything still working" or "everything needing a decision" without
 * keeping the concrete statuses in sync.
 *
 * @stability stable
 */
export const ENHANCEMENT_STATUS_ALIASES = {
  /** Queued for, or currently running through, the model. */
  in_progress: ['pending', 'processing'],
  /** Staged and waiting on a human keep-both / replace / discard decision. */
  awaiting_decision: ['ready'],
  /** Resolved one way or another: nothing left to act on. */
  terminal: ['applied', 'discarded', 'expired'],
} as const satisfies Record<string, readonly EnhancementStatus[]>;

/**
 * One alias of {@link ENHANCEMENT_STATUS_ALIASES}.
 *
 * @stability stable
 */
export type EnhancementStatusAlias = keyof typeof ENHANCEMENT_STATUS_ALIASES;

/**
 * `GET /api/media/enhancements` query params (AI Enhancements hub).
 *
 * @stability experimental
 */
export const listEnhancementsQuerySchema = z.object({
  circleId: z.string().uuid(),
  status: z
    .enum([
      ...(ENHANCEMENT_STATUSES as unknown as [string, ...string[]]),
      ...(Object.keys(ENHANCEMENT_STATUS_ALIASES) as [string, ...string[]]),
    ])
    .optional(),
  /**
   * Narrow the hub listing to one bulk-enhance batch. Composes with `status`,
   * e.g. a batch's `awaiting_decision` rows.
   */
  batchId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * The parsed value of {@link listEnhancementsQuerySchema}.
 *
 * @stability experimental
 */
export type ListEnhancementsQuery = z.infer<typeof listEnhancementsQuerySchema>;
