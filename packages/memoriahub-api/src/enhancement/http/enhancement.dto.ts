import { createZodDto } from 'nestjs-zod';
import {
  ENHANCEMENT_STATUS_ALIASES,
  applyEnhancementSchema,
  bulkEnhanceByFilterSchema,
  bulkEnhanceSchema,
  enhanceParamsSchema,
  listEnhancementBatchesQuerySchema,
  listEnhancementsQuerySchema,
} from '@marinoscar/memoriahub-contract/enhancement';

import type { EnhancementStatus } from '../constants.js';

export { ENHANCEMENT_STATUS_ALIASES };

/**
 * The body of `POST /api/media/:id/enhance/:enhancementId/apply`.
 *
 * @stability experimental
 */
export class ApplyEnhancementDto extends createZodDto(applyEnhancementSchema) {}

/**
 * The body of `POST /api/media/bulk/enhance/by-filter`.
 *
 * @stability experimental
 */
export class BulkEnhanceByFilterDto extends createZodDto(bulkEnhanceByFilterSchema) {}

/**
 * The body of `POST /api/media/bulk/enhance`.
 *
 * @stability experimental
 */
export class BulkEnhanceDto extends createZodDto(bulkEnhanceSchema) {}

/**
 * The body of `POST /api/media/:id/enhance`.
 *
 * @stability experimental
 */
export class EnhanceParamsDto extends createZodDto(enhanceParamsSchema) {}

/**
 * The query of `GET /api/enhancement-batches`.
 *
 * @stability experimental
 */
export class ListEnhancementBatchesQueryDto extends createZodDto(listEnhancementBatchesQuerySchema) {}

/**
 * The query of `GET /api/media/enhancements`.
 *
 * @stability experimental
 */
export class ListEnhancementsQueryDto extends createZodDto(listEnhancementsQuerySchema) {}

/**
 * Expands the `status` query param into the concrete statuses to filter on, or `undefined` for "no
 * status filter". Aliases expand to their group; a concrete value narrows to just itself.
 *
 * @param status - the query value.
 * @stability experimental
 */
export function resolveStatusFilter(status: string | undefined): EnhancementStatus[] | undefined {
  if (!status) return undefined;
  const alias = (ENHANCEMENT_STATUS_ALIASES as Record<string, readonly string[] | undefined>)[status];
  if (alias) return [...alias] as EnhancementStatus[];
  return [status as EnhancementStatus];
}

/**
 * The validated body of a bulk enhance request.
 *
 * @stability experimental
 */
export type BulkEnhance = InstanceType<typeof BulkEnhanceDto>;

/**
 * The validated body of a bulk enhance by filter request.
 *
 * @stability experimental
 */
export type BulkEnhanceByFilter = InstanceType<typeof BulkEnhanceByFilterDto>;

/**
 * The validated parameters of one enhancement (the preset, the adjustments, the per-run overrides).
 *
 * @stability experimental
 */
export type EnhanceParams = InstanceType<typeof EnhanceParamsDto>;

/**
 * The validated query of the batch list.
 *
 * @stability experimental
 */
export type ListEnhancementBatchesQuery = InstanceType<typeof ListEnhancementBatchesQueryDto>;

/**
 * The validated query of the enhancement list.
 *
 * @stability experimental
 */
export type ListEnhancementsQuery = InstanceType<typeof ListEnhancementsQueryDto>;
