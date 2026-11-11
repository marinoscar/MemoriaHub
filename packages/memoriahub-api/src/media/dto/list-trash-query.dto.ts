import { createZodDto } from 'nestjs-zod';
import { listTrashQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { listTrashQuerySchema };

/**
 * The `ListTrashQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListTrashQueryDto extends createZodDto(listTrashQuerySchema) {}
