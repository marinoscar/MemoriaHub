import { createZodDto } from 'nestjs-zod';
import { bulkArchiveSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkArchiveSchema };

/**
 * The `BulkArchiveDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class BulkArchiveDto extends createZodDto(bulkArchiveSchema) {}
