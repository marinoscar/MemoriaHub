import { createZodDto } from 'nestjs-zod';
import { deleteForeverSchema } from '@marinoscar/memoriahub-contract/media';

export { deleteForeverSchema };

/**
 * The `DeleteForeverDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class DeleteForeverDto extends createZodDto(deleteForeverSchema) {}
