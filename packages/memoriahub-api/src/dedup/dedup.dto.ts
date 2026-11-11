import { createZodDto } from 'nestjs-zod';
import {
  bulkDismissDuplicateThresholdSchema,
  bulkResolveDuplicateSchema,
  bulkResolveDuplicateThresholdSchema,
  duplicateQuerySchema,
  resolveDuplicateSchema,
} from '@marinoscar/memoriahub-contract/dedup';

/**
 * Query of `GET /api/media/duplicates`.
 *
 * @stability experimental
 */
export class DuplicateQueryDto extends createZodDto(duplicateQuerySchema) {}

/**
 * Body of `POST /api/media/duplicates/:id/resolve`.
 *
 * @stability experimental
 */
export class ResolveDuplicateDto extends createZodDto(resolveDuplicateSchema) {}

/**
 * Body of `POST /api/media/duplicates/bulk/resolve`.
 *
 * @stability experimental
 */
export class BulkResolveDuplicateDto extends createZodDto(bulkResolveDuplicateSchema) {}

/**
 * Body of `POST /api/media/duplicates/bulk/resolve-by-threshold`.
 *
 * @stability experimental
 */
export class BulkResolveDuplicateThresholdDto extends createZodDto(bulkResolveDuplicateThresholdSchema) {}

/**
 * Body of `POST /api/media/duplicates/bulk/dismiss-by-threshold`.
 *
 * @stability experimental
 */
export class BulkDismissDuplicateThresholdDto extends createZodDto(bulkDismissDuplicateThresholdSchema) {}
