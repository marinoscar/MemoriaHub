import { createZodDto } from 'nestjs-zod';
import { sharedWithMeQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { sharedWithMeQuerySchema };

/**
 * The `SharedWithMeQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class SharedWithMeQueryDto extends createZodDto(sharedWithMeQuerySchema) {}
