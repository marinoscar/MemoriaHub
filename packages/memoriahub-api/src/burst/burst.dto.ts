import { createZodDto } from 'nestjs-zod';
import {
  adminBurstBackfillSchema,
  bulkDismissBurstThresholdSchema,
  bulkResolveBurstSchema,
  bulkResolveBurstThresholdSchema,
  burstBackfillSchema,
  burstQuerySchema,
  resolveBurstSchema,
} from '@marinoscar/memoriahub-contract/burst';

/**
 * Query of `GET /api/media/bursts`.
 *
 * @stability experimental
 */
export class BurstQueryDto extends createZodDto(burstQuerySchema) {}

/**
 * Body of `POST /api/media/bursts/:id/resolve`.
 *
 * @stability experimental
 */
export class ResolveBurstDto extends createZodDto(resolveBurstSchema) {}

/**
 * Body of `POST /api/media/bursts/bulk/resolve`.
 *
 * @stability experimental
 */
export class BulkResolveBurstDto extends createZodDto(bulkResolveBurstSchema) {}

/**
 * Body of `POST /api/media/bursts/bulk/resolve-by-threshold`.
 *
 * @stability experimental
 */
export class BulkResolveBurstThresholdDto extends createZodDto(bulkResolveBurstThresholdSchema) {}

/**
 * Body of `POST /api/media/bursts/bulk/dismiss-by-threshold`.
 *
 * @stability experimental
 */
export class BulkDismissBurstThresholdDto extends createZodDto(bulkDismissBurstThresholdSchema) {}

/**
 * The per-circle backfill body.
 *
 * @stability experimental
 */
export class BurstBackfillDto extends createZodDto(burstBackfillSchema) {}

/**
 * Body of `POST /api/admin/bursts/backfill`.
 *
 * @stability experimental
 */
export class AdminBurstBackfillDto extends createZodDto(adminBurstBackfillSchema) {}
