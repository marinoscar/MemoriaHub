import { MediaEnhancementStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Concrete `MediaEnhancementStatus` values, plus three convenience aliases the
 * hub UI actually thinks in terms of. The aliases exist so a client can ask for
 * "everything still working" or "everything needing a decision" without having
 * to know (and keep in sync with) which concrete statuses those map to.
 */
export const ENHANCEMENT_STATUS_ALIASES = {
  /** Queued for, or currently running through, the model. */
  in_progress: [MediaEnhancementStatus.pending, MediaEnhancementStatus.processing],
  /** Staged and waiting on a human keep-both / replace / discard decision. */
  awaiting_decision: [MediaEnhancementStatus.ready],
  /** Resolved one way or another — nothing left to act on. */
  terminal: [
    MediaEnhancementStatus.applied,
    MediaEnhancementStatus.discarded,
    MediaEnhancementStatus.expired,
  ],
} as const satisfies Record<string, readonly MediaEnhancementStatus[]>;

export type EnhancementStatusAlias = keyof typeof ENHANCEMENT_STATUS_ALIASES;

/** GET /api/media/enhancements query params (issue #201, AI Enhancements hub). */
export const listEnhancementsQuerySchema = z.object({
  circleId: z.string().uuid(),
  status: z
    .enum([
      ...(Object.values(MediaEnhancementStatus) as [string, ...string[]]),
      ...(Object.keys(ENHANCEMENT_STATUS_ALIASES) as [string, ...string[]]),
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListEnhancementsQuery = z.infer<typeof listEnhancementsQuerySchema>;

export class ListEnhancementsQueryDto extends createZodDto(listEnhancementsQuerySchema) {}

/**
 * Expand the `status` query param into the concrete statuses to filter on, or
 * `undefined` for "no status filter". Aliases expand to their group; a concrete
 * value narrows to just itself.
 */
export function resolveStatusFilter(
  status: string | undefined,
): MediaEnhancementStatus[] | undefined {
  if (!status) return undefined;
  const alias = ENHANCEMENT_STATUS_ALIASES[status as EnhancementStatusAlias];
  if (alias) return [...alias];
  return [status as MediaEnhancementStatus];
}
