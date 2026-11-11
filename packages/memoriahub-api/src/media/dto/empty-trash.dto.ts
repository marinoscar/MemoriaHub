import { createZodDto } from 'nestjs-zod';
import { emptyTrashSchema } from '@marinoscar/memoriahub-contract/media';

export { emptyTrashSchema };

/**
 * The `EmptyTrashDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class EmptyTrashDto extends createZodDto(emptyTrashSchema) {}
