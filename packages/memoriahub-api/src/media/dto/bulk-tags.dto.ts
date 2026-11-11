import { createZodDto } from 'nestjs-zod';
import { bulkTagsSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkTagsSchema };

/**
 * The `BulkTagsDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class BulkTagsDto extends createZodDto(bulkTagsSchema) {}
