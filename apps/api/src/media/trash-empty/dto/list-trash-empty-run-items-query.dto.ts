import { createZodDto } from 'nestjs-zod';
import { listTrashEmptyRunItemsQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { listTrashEmptyRunItemsQuerySchema };

export class ListTrashEmptyRunItemsQueryDto extends createZodDto(listTrashEmptyRunItemsQuerySchema) {}
