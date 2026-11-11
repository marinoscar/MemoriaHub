import { createZodDto } from 'nestjs-zod';
import { listArchivedQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { listArchivedQuerySchema };

/**
 * The `ListArchivedQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListArchivedQueryDto extends createZodDto(listArchivedQuerySchema) {}
