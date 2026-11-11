import { createZodDto } from 'nestjs-zod';
import { updateMediaSchema } from '@marinoscar/memoriahub-contract/media';

export { updateMediaSchema };

/**
 * The `UpdateMediaDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class UpdateMediaDto extends createZodDto(updateMediaSchema) {}
