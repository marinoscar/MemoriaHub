import { createZodDto } from 'nestjs-zod';
import { bulkUpdateMediaSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkUpdateMediaSchema };

/**
 * The `BulkUpdateMediaDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class BulkUpdateMediaDto extends createZodDto(bulkUpdateMediaSchema) {}
