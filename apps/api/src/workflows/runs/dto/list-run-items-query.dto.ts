import { createZodDto } from 'nestjs-zod';
import { listRunItemsQuerySchema } from '@marinoscar/memoriahub-contract/workflows';

export { listRunItemsQuerySchema };

export class ListRunItemsQueryDto extends createZodDto(listRunItemsQuerySchema) {}
