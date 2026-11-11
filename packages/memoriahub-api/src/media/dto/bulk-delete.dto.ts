import { createZodDto } from 'nestjs-zod';
import { bulkDeleteSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkDeleteSchema };

/**
 * The `BulkDeleteDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class BulkDeleteDto extends createZodDto(bulkDeleteSchema) {}
