import { MediaEnhancementStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';

// The query schema, the status vocabulary and the three aliases live in
// `@marinoscar/memoriahub-contract/enhancement`; the expansion below keeps the
// Prisma enum type the service filters with.
import {
  ENHANCEMENT_STATUS_ALIASES,
  listEnhancementsQuerySchema,
  type EnhancementStatusAlias,
  type ListEnhancementsQuery,
} from '@marinoscar/memoriahub-contract/enhancement';

export { ENHANCEMENT_STATUS_ALIASES, listEnhancementsQuerySchema };
export type { EnhancementStatusAlias, ListEnhancementsQuery };

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
  if (alias) return [...alias] as MediaEnhancementStatus[];
  return [status as MediaEnhancementStatus];
}
