import { createZodDto } from 'nestjs-zod';
import { createMediaSchema } from '@marinoscar/memoriahub-contract/media';

export { createMediaSchema };

/**
 * The `CreateMediaDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CreateMediaDto extends createZodDto(createMediaSchema) {}
