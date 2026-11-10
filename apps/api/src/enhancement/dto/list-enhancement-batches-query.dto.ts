import { createZodDto } from 'nestjs-zod';
import { listEnhancementBatchesQuerySchema, type ListEnhancementBatchesQuery } from '@marinoscar/memoriahub-contract/enhancement';

export { listEnhancementBatchesQuerySchema };
export type { ListEnhancementBatchesQuery };

export class ListEnhancementBatchesQueryDto extends createZodDto(listEnhancementBatchesQuerySchema) {}
