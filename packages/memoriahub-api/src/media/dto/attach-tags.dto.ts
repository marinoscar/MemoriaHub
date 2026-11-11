import { createZodDto } from 'nestjs-zod';
import { attachTagsSchema } from '@marinoscar/memoriahub-contract/media';

export { attachTagsSchema };

/**
 * The `AttachTagsDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class AttachTagsDto extends createZodDto(attachTagsSchema) {}
