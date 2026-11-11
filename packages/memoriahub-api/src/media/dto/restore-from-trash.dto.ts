import { createZodDto } from 'nestjs-zod';
import { restoreFromTrashSchema } from '@marinoscar/memoriahub-contract/media';

export { restoreFromTrashSchema };

/**
 * The `RestoreFromTrashDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class RestoreFromTrashDto extends createZodDto(restoreFromTrashSchema) {}
