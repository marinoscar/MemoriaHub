import { createZodDto } from 'nestjs-zod';
import { createTrashEmptyRunSchema, listTrashEmptyRunItemsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { createTrashEmptyRunSchema, listTrashEmptyRunItemsQuerySchema };

/**
 * The `CreateTrashEmptyRunDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class CreateTrashEmptyRunDto extends createZodDto(createTrashEmptyRunSchema) {}

/**
 * The `ListTrashEmptyRunItemsQueryDto` request or response shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ListTrashEmptyRunItemsQueryDto extends createZodDto(listTrashEmptyRunItemsQuerySchema) {}
